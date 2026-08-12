/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — LLM Harness Types
 *  Provider-neutral vocabulary for the agent loop
 * ═══════════════════════════════════════════════════════════════
 */

export type Role = 'user' | 'assistant' | 'tool';

export interface TextMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface ToolResultMessage {
  role: 'tool';
  toolCallId: string;
  toolName: string;
  content: string;
  isError: boolean;
}

export type LlmMessage = TextMessage | ToolResultMessage;

export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** A tool the model may call. Handlers must be side-effect-explicit and total. */
export interface ToolDefinition<TArgs extends Record<string, unknown> = Record<string, unknown>> {
  name: string;
  description: string;
  parameters: SchemaNode;
  /** Rejections are captured and fed back to the model rather than aborting the run. */
  handler: (args: TArgs, ctx: ToolContext) => Promise<unknown>;
}

export interface ToolContext {
  runId: string;
  step: number;
  signal: AbortSignal;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
}

export type FinishReason = 'stop' | 'tool_calls' | 'length' | 'filtered';

export interface ProviderRequest {
  system?: string;
  messages: LlmMessage[];
  tools?: ToolDefinition[];
  temperature?: number;
  maxOutputTokens?: number;
}

export interface ProviderResponse {
  text: string;
  toolCalls: ToolCall[];
  usage: Usage;
  finishReason: FinishReason;
}

/**
 * The single seam every model backend implements. Keeping it this narrow is
 * what makes the loop testable without a network.
 */
export interface Provider {
  readonly name: string;
  readonly model: string;
  generate(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse>;
}

/* ─────────────────────────────────────────────────────────────
   Schema — a deliberately small runtime validator.
   Enough to constrain tool arguments and structured output without
   pulling a validation library into the bundle.
   ───────────────────────────────────────────────────────────── */

export type SchemaNode =
  | { type: 'string'; description?: string; enum?: readonly string[]; minLength?: number; maxLength?: number }
  | { type: 'number'; description?: string; minimum?: number; maximum?: number; integer?: boolean }
  | { type: 'boolean'; description?: string }
  | { type: 'array'; description?: string; items: SchemaNode; minItems?: number; maxItems?: number }
  | {
      type: 'object';
      description?: string;
      properties: Record<string, SchemaNode>;
      required?: readonly string[];
      additionalProperties?: boolean;
    };

/* ─────────────────────────────────────────────────────────────
   Tracing
   ───────────────────────────────────────────────────────────── */

export interface ToolInvocationTrace {
  toolName: string;
  toolCallId: string;
  durationMs: number;
  ok: boolean;
  error?: string;
}

export interface StepTrace {
  step: number;
  startedAt: number;
  durationMs: number;
  attempts: number;
  usage: Usage;
  finishReason: FinishReason;
  toolInvocations: ToolInvocationTrace[];
  /** Set when the step's output failed structured validation. */
  validationErrors?: string[];
}

export type RunOutcome = 'completed' | 'budget_exceeded' | 'invalid_output' | 'aborted' | 'failed';

export interface RunTrace {
  runId: string;
  provider: string;
  model: string;
  startedAt: number;
  durationMs: number;
  steps: StepTrace[];
  usage: Usage;
  costUsd: number;
  outcome: RunOutcome;
  error?: string;
}

export interface RunResult<T = string> {
  /** Parsed structured output when an output schema was supplied, else raw text. */
  output: T;
  text: string;
  trace: RunTrace;
}
