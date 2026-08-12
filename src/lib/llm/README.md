# LLM Harness

The execution scaffolding around a model call: the agent loop, budgets, retries,
structured output, and a trace of what happened. Zero runtime dependencies
beyond the Gemini SDK the app already ships.

```ts
import { GeminiProvider, runAgent } from '@/lib/llm';

const result = await runAgent({
  provider: new GeminiProvider({ apiKey: process.env.GEMINI_API_KEY! }),
  system: 'You are an OSINT analyst.',
  prompt: 'Summarise the seismic picture.',
  tools: [lookupTool],
  limits: { maxSteps: 4, maxTotalTokens: 40_000, maxCostUsd: 0.05 },
});

result.output;         // string, or the validated object when `output` is set
result.trace.outcome;  // 'completed' | 'budget_exceeded' | 'invalid_output' | 'aborted' | 'failed'
result.trace.costUsd;
```

## The loop

```
                ┌──────────────────────────────┐
                │ budget.beginStep()           │  ← throws before spending
                └──────────────┬───────────────┘
                               ▼
                ┌──────────────────────────────┐
                │ provider.generate()          │  ← retried on 429/5xx/transport
                └──────────────┬───────────────┘
                               ▼
                    tool calls?  ──yes──▶ run every tool, append results ──┐
                               │                                          │
                               no                                         │
                               ▼                                          │
                    output schema?  ──no──▶ return text                    │
                               │                                          │
                              yes                                         │
                               ▼                                          │
                    validates?  ──yes──▶ return parsed object              │
                               │                                          │
                               no ──▶ repair budget left? ──yes──▶ ────────┤
                                              │                            │
                                              no                           │
                                              ▼                            │
                                   OutputValidationError                   │
                                                                           │
                               ◀───────────────────────────────────────────┘
```

There are exactly four ways out, and every one of them lands in `trace.outcome`
rather than being left for the caller to infer.

## Design decisions worth knowing

**Budgets are checked before the call, not after.** `beginStep()` throws when
steps, tokens, cost or wall-clock are already spent, so an overrun costs nothing.
`maxSteps` is the backstop against a tool loop that never converges — always set it.

**Cost is estimated, never zero.** An unpriced model falls back to the flash rate
instead of silently disabling the cost ceiling.

**Tool failures are messages, not crashes.** An unknown tool name, arguments that
violate the declared schema, a handler that throws, a handler that hangs past
`toolTimeoutMs` — all come back to the model as an error result so it can correct
itself. Only budget, validation and abort end a run.

**Retries use full jitter.** `random() * capped`, not `capped/2 + random()*capped/2`:
when several runs retry at once, full jitter is what actually decorrelates them.
A server-supplied `Retry-After` overrides the curve.

**Retryable is a decision, not a guess.** 429 and 5xx are transient; other 4xx are
the caller's fault and retrying only burns budget. Transport errors with no status
are the most retryable case of all.

**Structured output survives real model behaviour.** `extractJson` handles fenced
blocks, prose preambles and trailing chatter before falling back to a brace-balanced
scan that ignores braces inside strings. A validation failure spends a repair
round-trip that quotes the exact errors back to the model.

**An already-aborted signal aborts immediately.** It never fires an `abort` event,
so the harness mirrors the state at construction — otherwise a cancelled caller
would still pay for a full run.

## Testing

`MockProvider` scripts turns — text, tool calls, errors — so every behaviour above
is exercised without a network. Inject `deps` to freeze the clock, the RNG and
`sleep`:

```ts
const provider = new MockProvider({
  script: [
    { kind: 'tools', calls: [{ name: 'lookup', arguments: { key: 'a' } }] },
    { kind: 'text', text: '{"answer":"42"}' },
  ],
});

await runAgent({
  provider,
  prompt: 'go',
  deps: { now: () => 1_000, runId: () => 'run_test', retry: { sleep: async () => {}, random: () => 0.5 } },
});

provider.requests; // every request the loop made, in order
```

## Files

| File                  | Role                                                        |
| --------------------- | ----------------------------------------------------------- |
| `harness.ts`          | The loop, tool invocation, repair                            |
| `budget.ts`           | Step/token/cost/wall-clock ceilings and model pricing        |
| `retry.ts`            | Backoff policy with injected clock and RNG                   |
| `schema.ts`           | JSON extraction, runtime validation, prompt rendering        |
| `errors.ts`           | Error hierarchy and retry classification                     |
| `providers/gemini.ts` | `@google/generative-ai` adapter                              |
| `providers/mock.ts`   | Scripted backend for tests                                   |
