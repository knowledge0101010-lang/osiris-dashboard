/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — LLM Harness Errors
 *  Retry classification lives here so every call site agrees on it
 * ═══════════════════════════════════════════════════════════════
 */

export class HarnessError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message);
    this.name = new.target.name;
    if (options?.cause !== undefined) this.cause = options.cause;
  }
}

/** The model backend failed. `status` is the HTTP status when there was one. */
export class ProviderError extends HarnessError {
  readonly status?: number;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    message: string,
    options: { status?: number; retryable?: boolean; retryAfterMs?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.retryable = options.retryable ?? classifyStatus(options.status);
  }
}

export type BudgetKind = 'steps' | 'inputTokens' | 'outputTokens' | 'totalTokens' | 'costUsd' | 'wallClock';

export class BudgetExceededError extends HarnessError {
  readonly kind: BudgetKind;
  readonly limit: number;
  readonly used: number;

  constructor(kind: BudgetKind, limit: number, used: number) {
    super(`Budget exhausted: ${kind} limit ${limit}, used ${used}.`);
    this.kind = kind;
    this.limit = limit;
    this.used = used;
  }
}

/** Structured output never validated, even after the repair attempts. */
export class OutputValidationError extends HarnessError {
  readonly errors: string[];
  readonly rawText: string;

  constructor(errors: string[], rawText: string) {
    super(`Model output failed validation: ${errors.join('; ')}`);
    this.errors = errors;
    this.rawText = rawText;
  }
}

export class ToolExecutionError extends HarnessError {
  readonly toolName: string;

  constructor(toolName: string, cause: unknown) {
    super(`Tool "${toolName}" threw: ${describe(cause)}`, { cause });
    this.toolName = toolName;
  }
}

export class AbortedError extends HarnessError {
  constructor(reason = 'Run aborted.') {
    super(reason);
  }
}

/* ─────────────────────────────────────────────────────────────
   Classification
   ───────────────────────────────────────────────────────────── */

/**
 * 429 and 5xx are transient; other 4xx are the caller's fault and retrying
 * only burns budget. An absent status means a transport failure, which is
 * the most retryable case of all.
 */
function classifyStatus(status: number | undefined): boolean {
  if (status === undefined) return true;
  if (status === 429) return true;
  return status >= 500 && status < 600;
}

const RETRYABLE_MESSAGE = /\b(ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|fetch failed|timeout)\b/i;

/** Whether an arbitrary thrown value is worth another attempt. */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ProviderError) return error.retryable;
  // Budget, validation and abort failures are decisions, not transient faults.
  if (error instanceof BudgetExceededError) return false;
  if (error instanceof OutputValidationError) return false;
  if (error instanceof AbortedError) return false;
  if (error instanceof ToolExecutionError) return false;
  if (error instanceof Error) {
    if (error.name === 'AbortError') return false;
    return RETRYABLE_MESSAGE.test(error.message);
  }
  return false;
}

export function describe(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
