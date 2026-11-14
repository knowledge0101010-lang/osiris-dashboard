/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — LLM Harness
 *  Public surface. Import from '@/lib/llm', not from the modules.
 * ═══════════════════════════════════════════════════════════════
 */

export { runAgent, type OutputSpec, type RunDeps, type RunOptions } from './harness';
export { Budget, DEFAULT_LIMITS, GEMINI_PRICING, pricingFor, type BudgetLimits, type BudgetSnapshot, type ModelPricing } from './budget';
export {
  AbortedError,
  BudgetExceededError,
  HarnessError,
  OutputValidationError,
  ProviderError,
  ToolExecutionError,
  describe,
  isRetryable,
  type BudgetKind,
} from './errors';
export { DEFAULT_RETRY, backoffDelay, realRetryDeps, withRetry, type RetryDeps, type RetryPolicy } from './retry';
export { describeSchema, extractJson, validate, type ValidationResult } from './schema';
export { MockProvider, type MockProviderOptions, type ScriptedTurn } from './providers/mock';
export { GeminiProvider, type GeminiProviderOptions } from './providers/gemini';
export type {
  FinishReason,
  LlmMessage,
  Provider,
  ProviderRequest,
  ProviderResponse,
  RunOutcome,
  RunResult,
  RunTrace,
  SchemaNode,
  StepTrace,
  TextMessage,
  ToolCall,
  ToolContext,
  ToolDefinition,
  ToolInvocationTrace,
  ToolResultMessage,
  Usage,
} from './types';
