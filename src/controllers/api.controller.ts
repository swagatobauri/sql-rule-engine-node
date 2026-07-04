import type { Request, Response } from "express";

import { normalizeSql } from "../services/normalization/query-normalizer.js";
import { generateFingerprint } from "../services/utils/fingerprint.js";
import { runRules } from "../services/rules/rule-engine.js";
import { evaluateQuery } from "../services/evaluation/evaluator.js";
import { getProblemById, getProblems } from "../services/problems/problem-repository.js";
import { ApiError, ApiSuccess } from "../utils/api-response.utils.js";
import { evaluateSchema, fingerprintSchema, normalizeSchema, problemIdParamSchema, rulesSchema, validateSchema, finalSubmitSchema, sessionQuestionIdParamSchema, evaluateFollowupSchema } from "./validation/index.js";
import { submitSessionQuestion } from "../services/submission/submit-service.js";
import { evaluateSqlFollowup } from "../services/evaluator/sql-followup-evaluator.js";
import type { AuthenticatedRequest } from "../middlewares/auth.middleware.js";
import { consumeRun } from "../services/run-limit/run-limit.service.js";
import { recordRun } from "../services/run-limit/run-log.service.js";
import { AppError } from "../utils/app-error.utils.js";

// Problems Controllers
export const getAllProblems = (_req: Request, res: Response): void => {
  try {
    const problems = getProblems();
    ApiSuccess(res, "Problems fetched successfully", 200, problems);
  } catch {
    ApiError(res, "Internal Server Error", 500);
  }
};

export const getProblemByIdController = (req: Request, res: Response): void => {
  try {
    const validation = validateSchema(problemIdParamSchema, {
      problemId: req.params.problemId,
    });

    if (!validation.success) {
      ApiError(res, validation.error, 400);
      return;
    }

    const { problemId } = validation.data;
    const problem = getProblemById(problemId);

    if (!problem) {
      ApiError(res, `Problem '${problemId}' not found`, 404);
      return;
    }

    ApiSuccess(res, "Problem fetched successfully", 200, problem);
  } catch {
    ApiError(res, "Internal Server Error", 500);
  }
};

// Normalize Controller
export const normalize = (req: Request, res: Response): void => {
  try {
    const validation = validateSchema(normalizeSchema, req.body);

    if (!validation.success) {
      ApiError(res, validation.error, 400);
      return;
    }

    const { sql } = validation.data;
    const parsed = normalizeSql(sql);

    if (parsed.error || !parsed.normalized_sql) {
      ApiError(res, parsed.error ?? "Invalid SQL query", 400);
      return;
    }

    ApiSuccess(res, "SQL normalized successfully", 200, {
      normalized_sql: parsed.normalized_sql,
      error: null,
    });
  } catch {
    ApiError(res, "Internal Server Error", 500);
  }
};

// Fingerprint Controller
export const generateFingerprintController = (req: Request, res: Response): void => {
  try {
    const validation = validateSchema(fingerprintSchema, req.body);

    if (!validation.success) {
      ApiError(res, validation.error, 400);
      return;
    }

    const { sql, schema_name, problem_id } = validation.data;
    const parsed = normalizeSql(sql);

    if (parsed.error || !parsed.normalized_sql) {
      ApiError(res, parsed.error ?? "Invalid SQL query", 400);
      return;
    }

    const problemId = typeof problem_id === "string" && problem_id.trim() ? problem_id : "global";

    const fingerprint = generateFingerprint(problemId, schema_name, parsed.normalized_sql);

    ApiSuccess(res, "Fingerprint generated successfully", 200, {
      fingerprint,
      normalized_sql: parsed.normalized_sql,
    });
  } catch {
    ApiError(res, "Internal Server Error", 500);
  }
};

// Rules Controller
export const runRulesController = (req: Request, res: Response): void => {
  try {
    const validation = validateSchema(rulesSchema, req.body);

    if (!validation.success) {
      ApiError(res, validation.error, 400);
      return;
    }

    const { sql } = validation.data;
    const parsed = normalizeSql(sql);

    if (parsed.error || !parsed.normalized_sql) {
      ApiError(res, parsed.error ?? "Invalid SQL query", 400);
      return;
    }

    const issues = runRules(parsed.ast);

    ApiSuccess(res, "Rules executed successfully", 200, {
      normalized_sql: parsed.normalized_sql,
      issues_count: issues.length,
      issues,
    });
  } catch {
    ApiError(res, "Internal Server Error", 500);
  }
};

// Evaluate Controller
export const evaluateQueryController = async (req: Request, res: Response): Promise<void> => {
  try {
    const validation = validateSchema(evaluateSchema, req.body);

    if (!validation.success) {
      ApiError(res, validation.error, 400);
      return;
    }

    const { sql, schema_name, problem_id } = validation.data;

    const problem = getProblemById(problem_id);
    if (!problem) {
      ApiError(res, `Problem '${problem_id}' not found`, 404);
      return;
    }

    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) {
      ApiError(res, "User is not authenticated", 401, undefined, "UNAUTHENTICATED");
      return;
    }

    // Enforce the per-question run quota BEFORE executing anything (caps DB load).
    // Throws AppError(429) when exhausted — handled below.
    const quota = await consumeRun(userId, problem_id);

    const startedAt = Date.now();
    const result = await evaluateQuery(sql, schema_name, problem_id);
    const runtimeMs = Date.now() - startedAt;

    // Track every run in history — best-effort, must not fail the request.
    try {
      await recordRun({
        userId,
        problemId: problem_id,
        schemaName: schema_name,
        sql,
        correct: result.error ? false : (result.correct ?? null),
        runtimeMs,
        error: result.error ?? null,
      });
    } catch (logErr) {
      console.error("Failed to record run history:", logErr);
    }

    if (result.error) {
      ApiError(res, result.error, 400);
      return;
    }

    ApiSuccess(res, "Query evaluated successfully", 200, { ...result, run_quota: quota });
  } catch (e) {
    if (e instanceof AppError) {
      ApiError(res, e.message, e.statusCode, e.details, e.errorCode);
      return;
    }
    console.log(e);
    ApiError(res, "Internal Server Error", 500);
  }
};

// Final Submit Controller
export const finalSubmitController = async (req: Request, res: Response): Promise<void> => {
  try {
    // 1. Authenticated user — guaranteed by authMiddleware on this route.
    const userId = (req as AuthenticatedRequest).user?.userId;
    if (!userId) {
      ApiError(res, "User is not authenticated", 401, {}, "UNAUTHENTICATED");
      return;
    }

    // 2. Validate URL Params
    const paramValidation = validateSchema(sessionQuestionIdParamSchema, {
      sessionQuestionId: req.params.sessionQuestionId,
    });
    if (!paramValidation.success) {
      ApiError(res, paramValidation.error, 400);
      return;
    }

    // 3. Validate Body
    const bodyValidation = validateSchema(finalSubmitSchema, req.body);
    if (!bodyValidation.success) {
      ApiError(res, bodyValidation.error, 400);
      return;
    }

    const { sessionQuestionId } = paramValidation.data;
    const { finalQuery, explanationText, edgeCaseText } = bodyValidation.data;

    // 4. Call Service layer
    const result = await submitSessionQuestion(
      sessionQuestionId,
      userId,
      finalQuery,
      explanationText,
      edgeCaseText
    );

    if (!result.success) {
      ApiError(
        res,
        result.error || "Submission failed",
        result.statusCode || 500,
        {},
        result.errorCode
      );
      return;
    }

    // 5. Success Response
    ApiSuccess(res, "Submission successful", 200, result.data);
  } catch (e) {
    console.error("Submit Error:", e);
    ApiError(res, "Internal Server Error", 500, {}, "FEEDBACK_FAILED");
  }
};

// Standalone Explanation Evaluation Controller (Assignment 2)
export const evaluateFollowupController = async (req: Request, res: Response): Promise<void> => {
  try {
    const attemptId = req.params.attemptId;
    if (!attemptId) {
      ApiError(res, "Attempt ID is required", 400);
      return;
    }

    const validation = validateSchema(evaluateFollowupSchema, req.body);
    if (!validation.success) {
      ApiError(res, validation.error, 400);
      return;
    }

    const { questionId, followupQuestion, answer } = validation.data;
    
    // Call the evaluator service independently
    const evaluation = await evaluateSqlFollowup({
      questionId,
      attemptId: attemptId as string,
      followupQuestion,
      answer
    });

    ApiSuccess(res, "Explanation evaluated successfully", 200, evaluation);
  } catch (error) {
    console.error("Evaluate Followup Error:", error);
    ApiError(res, "Internal Server Error", 500);
  }
};
