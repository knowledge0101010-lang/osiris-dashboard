/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Wiki Refresh Loop
 *  Selects what is new or stale, regenerates it through the harness,
 *  and writes back idempotently. One bad topic never sinks the run.
 * ═══════════════════════════════════════════════════════════════
 */

import { runAgent, type BudgetLimits, type Provider, type RunDeps, type ToolDefinition } from '@/lib/llm';
import { describe } from '@/lib/llm';
import { isStale, type StalenessPolicy, type WikiStore } from './store';
import { GENERATED_ENTRY_SCHEMA, type GeneratedEntry, type Signal, type Topic } from './types';

export const WIKI_SYSTEM_PROMPT = `You maintain the OSIRIS open-source intelligence wiki.

You write reference entries that an analyst reads to get oriented on a topic fast.

RULES
- Ground every claim in the signals supplied. If the signals do not support a claim, leave it out.
- Never invent a source. The "sources" array may only cite signals given to you.
- State uncertainty plainly. Set "confidence" to reflect the evidence you actually have, not the
  confidence you wish you had. Thin or conflicting signals mean "low".
- Prefer specifics — names, dates, magnitudes, identifiers — over general characterisation.
- Write the body in Markdown with "##" sections. Do not include an H1; the title supplies it.
- Distinguish what is observed from what is inferred.`;

export interface TopicOutcome {
  slug: string;
  status: 'created' | 'updated' | 'unchanged' | 'skipped' | 'failed';
  reason?: string;
  revision?: number;
  costUsd?: number;
  durationMs?: number;
}

export interface LoopReport {
  startedAt: string;
  durationMs: number;
  considered: number;
  selected: number;
  created: number;
  updated: number;
  unchanged: number;
  skipped: number;
  failed: number;
  costUsd: number;
  outcomes: TopicOutcome[];
}

export interface WikiLoopOptions {
  store: WikiStore;
  provider: Provider;
  topics: Topic[];
  policy?: StalenessPolicy;
  /** Cap on topics regenerated per run — the spend ceiling for the whole loop. */
  maxTopicsPerRun?: number;
  /** Per-topic harness budget. */
  limits?: Partial<BudgetLimits>;
  /** Signals beyond this are dropped, highest weight first. */
  maxSignalsPerTopic?: number;
  tools?: ToolDefinition[];
  dryRun?: boolean;
  now?: () => Date;
  harnessDeps?: Partial<RunDeps>;
  onTopic?: (outcome: TopicOutcome) => void;
}

export const DEFAULT_POLICY: StalenessPolicy = { ttlMs: 24 * 60 * 60 * 1000 };

export async function runWikiLoop(options: WikiLoopOptions): Promise<LoopReport> {
  const now = options.now ?? (() => new Date());
  const policy = options.policy ?? DEFAULT_POLICY;
  const maxTopics = options.maxTopicsPerRun ?? 10;
  const maxSignals = options.maxSignalsPerTopic ?? 25;
  const startedAt = now();

  const outcomes: TopicOutcome[] = [];
  let costUsd = 0;

  /* ── Selection ── */
  const selected: Topic[] = [];
  for (const topic of options.topics) {
    const existing = await options.store.read(topic.slug);
    const latestSignalAt = latestSignal(topic.signals);

    if (topic.signals.length === 0 && existing) {
      outcomes.push({ slug: topic.slug, status: 'skipped', reason: 'no signals' });
      continue;
    }
    if (!isStale(existing, { now: startedAt, policy, latestSignalAt })) {
      outcomes.push({ slug: topic.slug, status: 'skipped', reason: 'fresh' });
      continue;
    }
    if (selected.length >= maxTopics) {
      outcomes.push({ slug: topic.slug, status: 'skipped', reason: 'run cap reached' });
      continue;
    }
    selected.push(topic);
  }

  /* ── Generation ── */
  for (const topic of selected) {
    const topicStart = now().getTime();
    try {
      if (options.dryRun) {
        outcomes.push({ slug: topic.slug, status: 'skipped', reason: 'dry run' });
        continue;
      }

      const result = await runAgent<GeneratedEntry>({
        provider: options.provider,
        system: WIKI_SYSTEM_PROMPT,
        prompt: buildPrompt(topic, maxSignals),
        tools: options.tools,
        output: { schema: GENERATED_ENTRY_SCHEMA, repairAttempts: 1 },
        limits: options.limits,
        deps: options.harnessDeps,
      });

      costUsd += result.trace.costUsd;

      const write = await options.store.write(topic.slug, result.output, {
        provider: result.trace.provider,
        model: result.trace.model,
        runId: result.trace.runId,
      });

      const outcome: TopicOutcome = {
        slug: topic.slug,
        status: write.outcome,
        revision: write.entry.revision,
        costUsd: result.trace.costUsd,
        durationMs: now().getTime() - topicStart,
      };
      outcomes.push(outcome);
      options.onTopic?.(outcome);
    } catch (error) {
      // Isolation is the point: a malformed answer or an exhausted budget on
      // one topic must not cost the other topics their turn.
      const traced = error as { trace?: { costUsd?: number } };
      costUsd += traced.trace?.costUsd ?? 0;
      const outcome: TopicOutcome = {
        slug: topic.slug,
        status: 'failed',
        reason: describe(error),
        durationMs: now().getTime() - topicStart,
      };
      outcomes.push(outcome);
      options.onTopic?.(outcome);
    }
  }

  const tally = (status: TopicOutcome['status']): number =>
    outcomes.filter((outcome) => outcome.status === status).length;

  return {
    startedAt: startedAt.toISOString(),
    durationMs: now().getTime() - startedAt.getTime(),
    considered: options.topics.length,
    selected: selected.length,
    created: tally('created'),
    updated: tally('updated'),
    unchanged: tally('unchanged'),
    skipped: tally('skipped'),
    failed: tally('failed'),
    costUsd,
    outcomes,
  };
}

/* ─────────────────────────────────────────────────────────────
   Prompt construction
   ───────────────────────────────────────────────────────────── */

export function buildPrompt(topic: Topic, maxSignals: number): string {
  // Highest-weight signals first, so truncation drops the least useful evidence.
  const signals = [...topic.signals]
    .sort((a, b) => b.weight - a.weight || a.observedAt.localeCompare(b.observedAt))
    .slice(0, maxSignals);

  const lines: string[] = [`## TOPIC\n${topic.title}`];
  if (topic.focus) lines.push(`\n## FOCUS\n${topic.focus}`);

  lines.push(`\n## SIGNALS (${signals.length}${topic.signals.length > signals.length ? ` of ${topic.signals.length}` : ''})`);
  if (signals.length === 0) {
    lines.push('None supplied. Say so in the entry and set confidence to "low".');
  } else {
    for (const signal of signals) {
      const url = signal.url ? ` | ${signal.url}` : '';
      lines.push(`- [w${signal.weight}] ${signal.observedAt} | ${signal.label}${url}\n  ${signal.detail}`);
    }
  }

  lines.push('\nWrite the wiki entry for this topic from the signals above.');
  return lines.join('\n');
}

function latestSignal(signals: Signal[]): Date | undefined {
  let latest: number | undefined;
  for (const signal of signals) {
    const observed = Date.parse(signal.observedAt);
    if (Number.isFinite(observed) && (latest === undefined || observed > latest)) latest = observed;
  }
  return latest === undefined ? undefined : new Date(latest);
}
