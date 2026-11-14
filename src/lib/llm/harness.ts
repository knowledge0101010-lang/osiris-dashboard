/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Agent Harness
 *  The loop: call → tools → call … under hard budgets, with retries,
 *  structured-output repair, and a trace of everything that happened.
 * ═══════════════════════════════════════════════════════════════
 */

import { Budget, pricingFor, type BudgetLimits } from './budget';
import {
  AbortedError,
  BudgetExceededError,
  OutputValidationError,
  ToolExecutionError,
  describe,
} from './errors';
import { DEFAULT_RETRY, realRetryDeps, withRetry, type RetryDeps, type RetryPolicy } from './retry';
import { describeSchema, extractJson, validate } from './schema';
import type {
  LlmMessage,
  Provider,
  RunResult,
  RunTrace,
  SchemaNode,
  StepTrace,
  ToolDefinition,
  ToolInvocationTrace,
  Usage,
} from './types';

export interface OutputSpec {
  schema: SchemaNode;
  /** Extra round-trips granted purely to fix malformed output. Default 1. */
  repairAttempts?: number;
}

export interface RunOptions<T> {
  provider: Provider;
  prompt: string;
  system?: string;
  tools?: ToolDefinition[];
  output?: OutputSpec;
  limits?: Partial<BudgetLimits>;
  retry?: RetryPolicy;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Per-tool wall-clock ceiling. Default 30s. */
  toolTimeoutMs?: number;
  onStep?: (step: StepTrace) => void;
  /** Injected for deterministic tests. */
  deps?: Partial<RunDeps>;
  /** Narrows the parsed structured output; purely a typing aid. */
  parse?: (value: unknown) => T;
}

export interface RunDeps {
  now: () => number;
  retry: RetryDeps;
  runId: () => string;
}

const defaultDeps: RunDeps = {
  now: Date.now,
  retry: realRetryDeps,
  runId: () => `run_${Math.random().toString(36).slice(2, 10)}`,
};

const DEFAULT_TOOL_TIMEOUT_MS = 30_000;

/**
 * Runs an agent to completion.
 *
 * The loop only ever ends four ways — a clean answer, an exhausted budget,
 * output that never validated, or an abort — and every one of them is
 * reported in `trace.outcome` rather than left for the caller to infer.
 */
export async function runAgent<T = string>(options: RunOptions<T>): Promise<RunResult<T>> {
  const deps: RunDeps = { ...defaultDeps, ...options.deps };
  const runId = deps.runId();
  const startedAt = deps.now();
  const budget = new Budget(options.limits, {
    pricing: pricingFor(options.provider.model),
    now: deps.now,
  });

  const controller = new AbortController();
  const abortOuter = (): void => controller.abort();
  // An already-aborted signal never fires its event, so mirror the state now —
  // otherwise a cancelled caller would still pay for a full run.
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', abortOuter, { once: true });

  const steps: StepTrace[] = [];
  const totals: Usage = { inputTokens: 0, outputTokens: 0 };
  const toolsByName = new Map((options.tools ?? []).map((tool) => [tool.name, tool]));

  const messages: LlmMessage[] = [{ role: 'user', content: options.prompt }];
  const system = options.output
    ? `${options.system ?? ''}\n\n${outputInstruction(options.output.schema)}`.trim()
    : options.system;

  let repairsLeft = options.output?.repairAttempts ?? 1;

  const finish = (outcome: RunTrace['outcome'], error?: string): RunTrace => ({
    runId,
    provider: options.provider.name,
    model: options.provider.model,
    startedAt,
    durationMs: deps.now() - startedAt,
    steps,
    usage: { ...totals },
    costUsd: budget.snapshot().costUsd,
    outcome,
    error,
  });

  try {
    for (;;) {
      if (controller.signal.aborted) throw new AbortedError();
      budget.beginStep();
      const stepIndex = steps.length;
      const stepStart = deps.now();

      const { value: response, attempts } = await withRetry(
        () =>
          options.provider.generate(
            {
              system,
              messages,
              tools: options.tools,
              temperature: options.temperature,
              maxOutputTokens: options.maxOutputTokens,
            },
            controller.signal,
          ),
        { policy: options.retry ?? DEFAULT_RETRY, deps: deps.retry, signal: controller.signal },
      );

      budget.charge(response.usage);
      totals.inputTokens += response.usage.inputTokens;
      totals.outputTokens += response.usage.outputTokens;

      const step: StepTrace = {
        step: stepIndex,
        startedAt: stepStart,
        durationMs: deps.now() - stepStart,
        attempts,
        usage: response.usage,
        finishReason: response.finishReason,
        toolInvocations: [],
      };

      /* ── Tool calls: run them all, feed every result back ── */
      if (response.toolCalls.length > 0) {
        if (response.text) messages.push({ role: 'assistant', content: response.text });

        for (const call of response.toolCalls) {
          const invocation = await invokeTool({
            call,
            tool: toolsByName.get(call.name),
            runId,
            step: stepIndex,
            signal: controller.signal,
            timeoutMs: options.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS,
            now: deps.now,
          });
          step.toolInvocations.push(invocation.trace);
          messages.push(invocation.message);
        }

        steps.push(step);
        options.onStep?.(step);
        continue;
      }

      /* ── No tool calls: this is the model's answer ── */
      if (!options.output) {
        steps.push(step);
        options.onStep?.(step);
        return { output: response.text as unknown as T, text: response.text, trace: finish('completed') };
      }

      const parsed = extractJson(response.text);
      const result = parsed.ok
        ? validate(parsed.value, options.output.schema)
        : { ok: false as const, errors: [parsed.error] };

      if (result.ok) {
        steps.push(step);
        options.onStep?.(step);
        const value = options.parse ? options.parse(result.value) : (result.value as T);
        return { output: value, text: response.text, trace: finish('completed') };
      }

      step.validationErrors = result.errors;
      steps.push(step);
      options.onStep?.(step);

      if (repairsLeft <= 0) {
        const error = new OutputValidationError(result.errors, response.text);
        throw Object.assign(error, { trace: finish('invalid_output', error.message) });
      }
      repairsLeft -= 1;
      messages.push({ role: 'assistant', content: response.text });
      messages.push({ role: 'user', content: repairInstruction(result.errors, options.output.schema) });
    }
  } catch (error) {
    if (error instanceof OutputValidationError) throw error;
    if (error instanceof BudgetExceededError) {
      throw Object.assign(error, { trace: finish('budget_exceeded', error.message) });
    }
    if (error instanceof AbortedError || (error instanceof Error && error.name === 'AbortError')) {
      throw Object.assign(new AbortedError(describe(error)), { trace: finish('aborted', describe(error)) });
    }
    throw Object.assign(error instanceof Error ? error : new Error(describe(error)), {
      trace: finish('failed', describe(error)),
    });
  } finally {
    options.signal?.removeEventListener('abort', abortOuter);
  }
}

/* ─────────────────────────────────────────────────────────────
   Tool invocation — a thrown tool is a message, not a crash
   ───────────────────────────────────────────────────────────── */

interface InvokeArgs {
  call: { id: string; name: string; arguments: Record<string, unknown> };
  tool: ToolDefinition | undefined;
  runId: string;
  step: number;
  signal: AbortSignal;
  timeoutMs: number;
  now: () => number;
}

async function invokeTool(
  args: InvokeArgs,
): Promise<{ trace: ToolInvocationTrace; message: LlmMessage }> {
  const start = args.now();
  const base = { toolName: args.call.name, toolCallId: args.call.id };

  const fail = (message: string): { trace: ToolInvocationTrace; message: LlmMessage } => ({
    trace: { ...base, durationMs: args.now() - start, ok: false, error: message },
    message: {
      role: 'tool',
      toolCallId: args.call.id,
      toolName: args.call.name,
      content: message,
      isError: true,
    },
  });

  if (!args.tool) {
    // Hallucinated tool names are common; telling the model beats aborting.
    return fail(`Unknown tool "${args.call.name}".`);
  }

  const validation = validate(args.call.arguments, args.tool.parameters);
  if (!validation.ok) {
    return fail(`Invalid arguments: ${validation.errors.join('; ')}`);
  }

  try {
    const value = await withTimeout(
      args.tool.handler(args.call.arguments, { runId: args.runId, step: args.step, signal: args.signal }),
      args.timeoutMs,
      args.call.name,
    );
    return {
      trace: { ...base, durationMs: args.now() - start, ok: true },
      message: {
        role: 'tool',
        toolCallId: args.call.id,
        toolName: args.call.name,
        content: typeof value === 'string' ? value : JSON.stringify(value),
        isError: false,
      },
    };
  } catch (error) {
    return fail(new ToolExecutionError(args.call.name, error).message);
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(`${label}: ${describe(error)}`));
      },
    );
  });
}

/* ─────────────────────────────────────────────────────────────
   Prompt fragments
   ───────────────────────────────────────────────────────────── */

function outputInstruction(schema: SchemaNode): string {
  return [
    'Respond with a single JSON value and nothing else — no prose, no code fences.',
    'It must match this shape:',
    describeSchema(schema),
  ].join('\n');
}

function repairInstruction(errors: string[], schema: SchemaNode): string {
  return [
    'That response did not satisfy the required schema:',
    ...errors.map((error) => `- ${error}`),
    '',
    'Reply with corrected JSON only. Required shape:',
    describeSchema(schema),
  ].join('\n');
}
