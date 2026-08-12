/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Retry
 *  Exponential backoff with full jitter. Clock and RNG are injected
 *  so the policy is testable without real waiting.
 * ═══════════════════════════════════════════════════════════════
 */

import { AbortedError, ProviderError, isRetryable } from './errors';

export interface RetryPolicy {
  /** Total attempts including the first. 1 disables retrying. */
  attempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

export const DEFAULT_RETRY: RetryPolicy = {
  attempts: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
};

export interface RetryDeps {
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  random: () => number;
}

export const realRetryDeps: RetryDeps = {
  sleep: (ms, signal) =>
    new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(new AbortedError());
        return;
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new AbortedError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });
    }),
  random: Math.random,
};

/**
 * Full jitter (`random() * capped`) rather than the more obvious
 * `capped/2 + random()*capped/2`: when several runs retry at once, full
 * jitter is what actually decorrelates them instead of just softening the spike.
 */
export function backoffDelay(attempt: number, policy: RetryPolicy, random: () => number): number {
  const capped = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1));
  return Math.floor(random() * capped);
}

export interface RetryOutcome<T> {
  value: T;
  attempts: number;
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: {
    policy?: RetryPolicy;
    deps?: RetryDeps;
    signal?: AbortSignal;
    onRetry?: (attempt: number, delayMs: number, error: unknown) => void;
  } = {},
): Promise<RetryOutcome<T>> {
  const policy = options.policy ?? DEFAULT_RETRY;
  const deps = options.deps ?? realRetryDeps;

  let lastError: unknown;
  for (let attempt = 1; attempt <= policy.attempts; attempt += 1) {
    if (options.signal?.aborted) throw new AbortedError();
    try {
      return { value: await operation(attempt), attempts: attempt };
    } catch (error) {
      lastError = error;
      if (!isRetryable(error) || attempt === policy.attempts) throw error;

      // A server-supplied Retry-After outranks our own backoff curve.
      const serverDelay = error instanceof ProviderError ? error.retryAfterMs : undefined;
      const delay = serverDelay ?? backoffDelay(attempt, policy, deps.random);
      options.onRetry?.(attempt, delay, error);
      await deps.sleep(delay, options.signal);
    }
  }
  throw lastError;
}
