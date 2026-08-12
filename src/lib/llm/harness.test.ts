import { describe, expect, it, vi } from 'vitest';
import { runAgent, type RunDeps } from './harness';
import { MockProvider, type ScriptedTurn } from './providers/mock';
import { AbortedError, BudgetExceededError, OutputValidationError, ProviderError } from './errors';
import type { SchemaNode, ToolDefinition } from './types';

/* A clock that only moves when asked, so durations are assertable. */
function fakeClock(startMs = 1_000): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

function deps(overrides: Partial<RunDeps> = {}): Partial<RunDeps> {
  return {
    now: () => 1_000,
    runId: () => 'run_test',
    retry: { sleep: async () => {}, random: () => 0.5 },
    ...overrides,
  };
}

const ANSWER_SCHEMA: SchemaNode = {
  type: 'object',
  required: ['answer', 'score'],
  additionalProperties: false,
  properties: {
    answer: { type: 'string', minLength: 1 },
    score: { type: 'number', minimum: 0, maximum: 10 },
  },
};

function provider(...script: ScriptedTurn[]): MockProvider {
  return new MockProvider({ script });
}

describe('runAgent — plain completion', () => {
  it('returns the model text and a completed trace', async () => {
    const p = provider({ kind: 'text', text: 'hello', usage: { inputTokens: 7, outputTokens: 3 } });
    const result = await runAgent({ provider: p, prompt: 'hi', deps: deps() });

    expect(result.output).toBe('hello');
    expect(result.trace.outcome).toBe('completed');
    expect(result.trace.usage).toEqual({ inputTokens: 7, outputTokens: 3 });
    expect(result.trace.steps).toHaveLength(1);
    expect(p.callCount).toBe(1);
  });

  it('passes the system prompt through to the provider', async () => {
    const p = provider({ kind: 'text', text: 'ok' });
    await runAgent({ provider: p, prompt: 'hi', system: 'be terse', deps: deps() });
    expect(p.requests[0].system).toBe('be terse');
  });

  it('charges cost against the model price list', async () => {
    const p = new MockProvider({
      model: 'gemini-2.0-flash',
      script: [{ kind: 'text', text: 'ok', usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 } }],
    });
    const result = await runAgent({ provider: p, prompt: 'hi', deps: deps() });
    // 0.10 in + 0.40 out per million tokens.
    expect(result.trace.costUsd).toBeCloseTo(0.5, 6);
  });
});

describe('runAgent — tool loop', () => {
  const lookup: ToolDefinition = {
    name: 'lookup',
    description: 'Look a value up',
    parameters: {
      type: 'object',
      required: ['key'],
      additionalProperties: false,
      properties: { key: { type: 'string' } },
    },
    handler: async (args) => ({ value: `resolved:${String(args.key)}` }),
  };

  it('executes a tool and feeds the result back', async () => {
    const p = provider(
      { kind: 'tools', calls: [{ name: 'lookup', arguments: { key: 'alpha' } }] },
      { kind: 'text', text: 'done' },
    );
    const result = await runAgent({ provider: p, prompt: 'go', tools: [lookup], deps: deps() });

    expect(result.output).toBe('done');
    expect(result.trace.steps).toHaveLength(2);
    expect(result.trace.steps[0].toolInvocations[0]).toMatchObject({ toolName: 'lookup', ok: true });

    const followUp = p.requests[1].messages.at(-1);
    expect(followUp).toMatchObject({ role: 'tool', toolName: 'lookup', isError: false });
    expect((followUp as { content: string }).content).toContain('resolved:alpha');
  });

  it('reports an unknown tool to the model instead of aborting', async () => {
    const p = provider(
      { kind: 'tools', calls: [{ name: 'nope', arguments: {} }] },
      { kind: 'text', text: 'recovered' },
    );
    const result = await runAgent({ provider: p, prompt: 'go', tools: [lookup], deps: deps() });

    expect(result.output).toBe('recovered');
    expect(result.trace.steps[0].toolInvocations[0]).toMatchObject({ ok: false });
    expect((p.requests[1].messages.at(-1) as { content: string }).content).toContain('Unknown tool');
  });

  it('rejects tool arguments that violate the declared schema, without calling the handler', async () => {
    const handler = vi.fn();
    const strict: ToolDefinition = { ...lookup, handler: async (...args) => handler(...args) };
    const p = provider(
      { kind: 'tools', calls: [{ name: 'lookup', arguments: { key: 42 } }] },
      { kind: 'text', text: 'ok' },
    );

    await runAgent({ provider: p, prompt: 'go', tools: [strict], deps: deps() });
    expect(handler).not.toHaveBeenCalled();
    expect((p.requests[1].messages.at(-1) as { content: string }).content).toContain('Invalid arguments');
  });

  it('turns a thrown tool into a message rather than a failed run', async () => {
    const exploding: ToolDefinition = {
      ...lookup,
      handler: async () => {
        throw new Error('database offline');
      },
    };
    const p = provider(
      { kind: 'tools', calls: [{ name: 'lookup', arguments: { key: 'x' } }] },
      { kind: 'text', text: 'handled' },
    );

    const result = await runAgent({ provider: p, prompt: 'go', tools: [exploding], deps: deps() });
    expect(result.trace.outcome).toBe('completed');
    expect(result.trace.steps[0].toolInvocations[0].error).toContain('database offline');
  });

  it('runs every call in a multi-call turn', async () => {
    const p = provider(
      {
        kind: 'tools',
        calls: [
          { name: 'lookup', arguments: { key: 'a' } },
          { name: 'lookup', arguments: { key: 'b' } },
        ],
      },
      { kind: 'text', text: 'both' },
    );
    const result = await runAgent({ provider: p, prompt: 'go', tools: [lookup], deps: deps() });
    expect(result.trace.steps[0].toolInvocations).toHaveLength(2);
  });
});

describe('runAgent — structured output', () => {
  it('parses and validates JSON output', async () => {
    const p = provider({ kind: 'text', text: '{"answer":"42","score":9}' });
    const result = await runAgent<{ answer: string; score: number }>({
      provider: p,
      prompt: 'q',
      output: { schema: ANSWER_SCHEMA },
      deps: deps(),
    });
    expect(result.output).toEqual({ answer: '42', score: 9 });
  });

  it('recovers JSON from a fenced block wrapped in prose', async () => {
    const p = provider({
      kind: 'text',
      text: 'Sure!\n```json\n{"answer":"42","score":1}\n```\nHope that helps.',
    });
    const result = await runAgent<{ answer: string }>({
      provider: p,
      prompt: 'q',
      output: { schema: ANSWER_SCHEMA },
      deps: deps(),
    });
    expect(result.output.answer).toBe('42');
  });

  it('asks for a repair once, then succeeds', async () => {
    const p = provider(
      { kind: 'text', text: '{"answer":"42"}' },
      { kind: 'text', text: '{"answer":"42","score":5}' },
    );
    const result = await runAgent<{ score: number }>({
      provider: p,
      prompt: 'q',
      output: { schema: ANSWER_SCHEMA, repairAttempts: 1 },
      deps: deps(),
    });

    expect(result.output.score).toBe(5);
    expect(result.trace.steps[0].validationErrors).toEqual(['$.score: required']);
    const repairPrompt = p.requests[1].messages.at(-1) as { content: string };
    expect(repairPrompt.content).toContain('$.score: required');
  });

  it('fails with the validation errors once repairs run out', async () => {
    const p = provider({ kind: 'text', text: 'not json at all' });
    const error = await runAgent({
      provider: p,
      prompt: 'q',
      output: { schema: ANSWER_SCHEMA, repairAttempts: 0 },
      deps: deps(),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(OutputValidationError);
    expect((error as OutputValidationError & { trace: { outcome: string } }).trace.outcome).toBe(
      'invalid_output',
    );
  });

  it('appends the required shape to the system prompt', async () => {
    const p = provider({ kind: 'text', text: '{"answer":"a","score":1}' });
    await runAgent({ provider: p, prompt: 'q', output: { schema: ANSWER_SCHEMA }, deps: deps() });
    expect(p.requests[0].system).toContain('"answer"');
    expect(p.requests[0].system).toContain('single JSON value');
  });
});

describe('runAgent — budgets', () => {
  it('stops a non-converging tool loop at maxSteps', async () => {
    const spinner: ToolDefinition = {
      name: 'spin',
      description: 'never resolves anything',
      parameters: { type: 'object', properties: {} },
      handler: async () => 'again',
    };
    const p = provider({ kind: 'tools', calls: [{ name: 'spin', arguments: {} }] });

    const error = await runAgent({
      provider: p,
      prompt: 'go',
      tools: [spinner],
      limits: { maxSteps: 3 },
      deps: deps(),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).kind).toBe('steps');
    expect(p.callCount).toBe(3);
  });

  it('refuses to start a step once the token ceiling is reached', async () => {
    const p = provider(
      { kind: 'tools', calls: [{ name: 'x', arguments: {} }], usage: { inputTokens: 900, outputTokens: 200 } },
      { kind: 'text', text: 'never reached' },
    );
    const error = await runAgent({
      provider: p,
      prompt: 'go',
      limits: { maxSteps: 5, maxTotalTokens: 1_000 },
      deps: deps(),
    }).catch((e: unknown) => e);

    expect((error as BudgetExceededError).kind).toBe('totalTokens');
    expect(p.callCount).toBe(1);
  });

  it('enforces the wall-clock ceiling', async () => {
    const clock = fakeClock();
    const slow: ToolDefinition = {
      name: 'slow',
      description: 'burns time',
      parameters: { type: 'object', properties: {} },
      handler: async () => {
        clock.advance(5_000);
        return 'ok';
      },
    };
    const p = provider({ kind: 'tools', calls: [{ name: 'slow', arguments: {} }] });

    const error = await runAgent({
      provider: p,
      prompt: 'go',
      tools: [slow],
      limits: { maxSteps: 50, maxWallMs: 8_000 },
      deps: deps({ now: clock.now }),
    }).catch((e: unknown) => e);

    expect((error as BudgetExceededError).kind).toBe('wallClock');
  });

  it('attaches the trace to a budget failure', async () => {
    const p = provider({ kind: 'tools', calls: [{ name: 'x', arguments: {} }] });
    const error = await runAgent({
      provider: p,
      prompt: 'go',
      limits: { maxSteps: 1 },
      deps: deps(),
    }).catch((e: unknown) => e as { trace?: { outcome: string; steps: unknown[] } });

    expect(error.trace?.outcome).toBe('budget_exceeded');
    expect(error.trace?.steps).toHaveLength(1);
  });
});

describe('runAgent — retries', () => {
  it('retries a 503 and reports the attempt count', async () => {
    const p = provider(
      { kind: 'error', error: new ProviderError('upstream unavailable', { status: 503 }) },
      { kind: 'text', text: 'second time lucky' },
    );
    const result = await runAgent({ provider: p, prompt: 'go', deps: deps() });

    expect(result.output).toBe('second time lucky');
    expect(result.trace.steps[0].attempts).toBe(2);
  });

  it('does not retry a 400', async () => {
    const p = provider({ kind: 'error', error: new ProviderError('bad request', { status: 400 }) });
    await expect(runAgent({ provider: p, prompt: 'go', deps: deps() })).rejects.toThrow('bad request');
    expect(p.callCount).toBe(1);
  });

  it('honours a server-supplied Retry-After over its own backoff', async () => {
    const sleeps: number[] = [];
    const p = provider(
      { kind: 'error', error: new ProviderError('slow down', { status: 429, retryAfterMs: 4_321 }) },
      { kind: 'text', text: 'ok' },
    );
    await runAgent({
      provider: p,
      prompt: 'go',
      deps: deps({
        retry: {
          sleep: async (ms: number) => {
            sleeps.push(ms);
          },
          random: () => 0.5,
        },
      }),
    });
    expect(sleeps).toEqual([4_321]);
  });

  it('gives up after the configured attempts', async () => {
    const p = provider({ kind: 'error', error: new ProviderError('flaky', { status: 500 }) });
    await expect(
      runAgent({ provider: p, prompt: 'go', retry: { attempts: 2, baseDelayMs: 1, maxDelayMs: 2 }, deps: deps() }),
    ).rejects.toThrow('flaky');
    expect(p.callCount).toBe(2);
  });
});

describe('runAgent — abort', () => {
  it('reports an aborted run', async () => {
    const controller = new AbortController();
    controller.abort();
    const p = provider({ kind: 'text', text: 'unused' });

    const error = await runAgent({ provider: p, prompt: 'go', signal: controller.signal, deps: deps() }).catch(
      (e: unknown) => e as AbortedError & { trace: { outcome: string } },
    );
    expect(error.trace.outcome).toBe('aborted');
  });
});
