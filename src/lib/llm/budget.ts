/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Run Budget
 *  Hard ceilings on steps, tokens, spend and wall-clock time.
 *  Checked *before* every provider call so an overrun costs nothing.
 * ═══════════════════════════════════════════════════════════════
 */

import { BudgetExceededError } from './errors';
import type { Usage } from './types';

export interface BudgetLimits {
  /** Provider round-trips. Always set this: it is the backstop against a tool-call loop that never converges. */
  maxSteps: number;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  maxTotalTokens?: number;
  maxCostUsd?: number;
  maxWallMs?: number;
}

/** USD per 1M tokens. */
export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface BudgetSnapshot {
  steps: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
  elapsedMs: number;
}

export const DEFAULT_LIMITS: BudgetLimits = {
  maxSteps: 8,
  maxTotalTokens: 120_000,
  maxWallMs: 120_000,
};

/**
 * Published Gemini rates (USD per 1M tokens). Wrong-but-close beats absent:
 * an unpriced model silently disables the cost ceiling, so unknown models
 * fall back to the flash rate rather than zero.
 */
export const GEMINI_PRICING: Record<string, ModelPricing> = {
  'gemini-2.0-flash': { inputPerMillion: 0.1, outputPerMillion: 0.4 },
  'gemini-2.0-flash-lite': { inputPerMillion: 0.075, outputPerMillion: 0.3 },
  'gemini-2.5-flash': { inputPerMillion: 0.3, outputPerMillion: 2.5 },
  'gemini-2.5-pro': { inputPerMillion: 1.25, outputPerMillion: 10 },
};

const FALLBACK_PRICING: ModelPricing = GEMINI_PRICING['gemini-2.0-flash'];

export function pricingFor(model: string): ModelPricing {
  return GEMINI_PRICING[model] ?? FALLBACK_PRICING;
}

export class Budget {
  private readonly limits: BudgetLimits;
  private readonly pricing: ModelPricing;
  private readonly now: () => number;
  private readonly startedAt: number;

  private steps = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private costUsd = 0;

  constructor(
    limits: Partial<BudgetLimits> = {},
    options: { pricing?: ModelPricing; now?: () => number } = {},
  ) {
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.pricing = options.pricing ?? FALLBACK_PRICING;
    this.now = options.now ?? Date.now;
    this.startedAt = this.now();
  }

  snapshot(): BudgetSnapshot {
    return {
      steps: this.steps,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      totalTokens: this.inputTokens + this.outputTokens,
      costUsd: this.costUsd,
      elapsedMs: this.now() - this.startedAt,
    };
  }

  /**
   * Reserves one provider round-trip. Throws rather than returning a flag so a
   * caller cannot proceed by ignoring the result.
   */
  beginStep(): void {
    const elapsed = this.now() - this.startedAt;
    if (this.limits.maxWallMs !== undefined && elapsed >= this.limits.maxWallMs) {
      throw new BudgetExceededError('wallClock', this.limits.maxWallMs, elapsed);
    }
    if (this.steps >= this.limits.maxSteps) {
      throw new BudgetExceededError('steps', this.limits.maxSteps, this.steps);
    }
    // Token and cost ceilings are checked here too: a step that starts already
    // over budget would otherwise spend real money before anyone notices.
    this.assertTokensWithinLimits();
    this.steps += 1;
  }

  /** Records what a completed step actually consumed. */
  charge(usage: Usage): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
    this.costUsd +=
      (usage.inputTokens / 1_000_000) * this.pricing.inputPerMillion +
      (usage.outputTokens / 1_000_000) * this.pricing.outputPerMillion;
  }

  private assertTokensWithinLimits(): void {
    const { maxInputTokens, maxOutputTokens, maxTotalTokens, maxCostUsd } = this.limits;
    if (maxInputTokens !== undefined && this.inputTokens >= maxInputTokens) {
      throw new BudgetExceededError('inputTokens', maxInputTokens, this.inputTokens);
    }
    if (maxOutputTokens !== undefined && this.outputTokens >= maxOutputTokens) {
      throw new BudgetExceededError('outputTokens', maxOutputTokens, this.outputTokens);
    }
    const total = this.inputTokens + this.outputTokens;
    if (maxTotalTokens !== undefined && total >= maxTotalTokens) {
      throw new BudgetExceededError('totalTokens', maxTotalTokens, total);
    }
    if (maxCostUsd !== undefined && this.costUsd >= maxCostUsd) {
      throw new BudgetExceededError('costUsd', maxCostUsd, this.costUsd);
    }
  }
}
