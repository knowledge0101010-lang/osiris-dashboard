/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Mock Provider
 *  A scripted backend. Every harness behaviour worth testing —
 *  tool loops, malformed output, transient failures — is expressible
 *  here without touching the network.
 * ═══════════════════════════════════════════════════════════════
 */

import { ProviderError } from '../errors';
import type { Provider, ProviderRequest, ProviderResponse, ToolCall } from '../types';

export type ScriptedTurn =
  | { kind: 'text'; text: string; usage?: Partial<{ inputTokens: number; outputTokens: number }> }
  | {
      kind: 'tools';
      calls: Array<{ name: string; arguments: Record<string, unknown>; id?: string }>;
      text?: string;
      usage?: Partial<{ inputTokens: number; outputTokens: number }>;
    }
  | { kind: 'error'; error: ProviderError };

export interface MockProviderOptions {
  name?: string;
  model?: string;
  /** Consumed in order; the last turn repeats once exhausted. */
  script: ScriptedTurn[];
}

export class MockProvider implements Provider {
  readonly name: string;
  readonly model: string;
  /** Every request the harness made, in order — the assertion surface for tests. */
  readonly requests: ProviderRequest[] = [];

  private readonly script: ScriptedTurn[];
  private cursor = 0;

  constructor(options: MockProviderOptions) {
    this.name = options.name ?? 'mock';
    this.model = options.model ?? 'mock-model';
    this.script = options.script;
    if (this.script.length === 0) throw new Error('MockProvider needs at least one scripted turn.');
  }

  get callCount(): number {
    return this.requests.length;
  }

  async generate(request: ProviderRequest, signal: AbortSignal): Promise<ProviderResponse> {
    if (signal.aborted) throw new ProviderError('aborted', { retryable: false });
    // Snapshot: the harness mutates its message array between steps.
    this.requests.push({ ...request, messages: [...request.messages] });

    const turn = this.script[Math.min(this.cursor, this.script.length - 1)];
    this.cursor += 1;

    if (turn.kind === 'error') throw turn.error;

    const usage = {
      inputTokens: turn.usage?.inputTokens ?? 10,
      outputTokens: turn.usage?.outputTokens ?? 5,
    };

    if (turn.kind === 'tools') {
      const calls: ToolCall[] = turn.calls.map((call, index) => ({
        id: call.id ?? `call_${this.cursor}_${index}`,
        name: call.name,
        arguments: call.arguments,
      }));
      return { text: turn.text ?? '', toolCalls: calls, usage, finishReason: 'tool_calls' };
    }

    return { text: turn.text, toolCalls: [], usage, finishReason: 'stop' };
  }
}
