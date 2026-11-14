/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Topic Derivation
 *  Turns the live intelligence context into wiki topics + signals.
 *  This is the seam between the platform's feeds and the LLM loop.
 * ═══════════════════════════════════════════════════════════════
 */

import type { IntelligenceContext } from '@/lib/ai-engine';
import { slugify } from './store';
import type { Signal, Topic } from './types';

export interface DeriveOptions {
  /** Topics with fewer signals than this are dropped as too thin to write about. */
  minSignals?: number;
  /** Cap on topics returned, highest total signal weight first. */
  maxTopics?: number;
}

/**
 * Groups the context by region and by threat domain. Region entries are what an
 * analyst actually looks up ("what is going on in X"); domain entries carry the
 * cross-cutting picture that a per-region view splits apart.
 */
export function deriveTopics(context: IntelligenceContext, options: DeriveOptions = {}): Topic[] {
  const minSignals = options.minSignals ?? 2;
  const maxTopics = options.maxTopics ?? 20;
  const byKey = new Map<string, Topic>();

  const push = (key: string, title: string, focus: string, signal: Signal): void => {
    const slug = slugify(key);
    let topic = byKey.get(slug);
    if (!topic) {
      topic = { slug, title, focus, signals: [] };
      byKey.set(slug, topic);
    }
    topic.signals.push(signal);
  };

  for (const quake of context.earthquakes) {
    const region = regionOf(quake.location);
    push(
      `region-${region}`,
      `Regional situation: ${region}`,
      'Cover seismic, conflict and cyber activity affecting this region.',
      {
        id: `eq-${quake.id}`,
        label: `M${quake.magnitude} earthquake — ${quake.location}`,
        detail: `Depth ${quake.depth}km at ${quake.latitude.toFixed(2)},${quake.longitude.toFixed(2)}.${
          quake.tsunami ? ' Tsunami flag set.' : ''
        }${quake.alert ? ` Alert level ${quake.alert}.` : ''}`,
        observedAt: quake.timestamp,
        weight: Math.min(10, Math.round(quake.magnitude)),
      },
    );
  }

  for (const item of context.news) {
    push(
      `domain-geopolitics`,
      'Geopolitical and conflict picture',
      'Synthesise the conflict and diplomatic signals into a current assessment.',
      {
        id: `news-${item.id}`,
        label: `${item.source}: ${item.title}`,
        detail: item.description || item.machine_assessment || 'No description supplied.',
        url: item.link,
        observedAt: item.published,
        weight: Math.max(1, Math.min(10, item.risk_score)),
      },
    );
  }

  for (const threat of context.threats) {
    push(
      `region-${regionOf(threat.region)}`,
      `Regional situation: ${regionOf(threat.region)}`,
      'Cover seismic, conflict and cyber activity affecting this region.',
      {
        id: `threat-${threat.id}`,
        label: `${threat.severity} ${threat.type} — ${threat.title}`,
        detail: threat.description,
        observedAt: threat.timestamp,
        weight: severityWeight(threat.severity),
      },
    );
  }

  for (const alert of context.cyberAlerts) {
    push(
      'domain-cyber',
      'Cyber threat landscape',
      'Assess active vulnerabilities for coordinated campaigns and infrastructure exposure.',
      {
        id: `cve-${alert.id}`,
        label: `${alert.id} — ${alert.vendor}/${alert.product}`,
        detail: `${alert.name}. Severity ${alert.severity}. Remediation due ${alert.due}.`,
        observedAt: alert.date,
        weight: severityWeight(alert.severity),
      },
    );
  }

  return [...byKey.values()]
    .filter((topic) => topic.signals.length >= minSignals)
    .sort((a, b) => totalWeight(b) - totalWeight(a) || a.slug.localeCompare(b.slug))
    .slice(0, maxTopics);
}

function totalWeight(topic: Topic): number {
  return topic.signals.reduce((sum, signal) => sum + signal.weight, 0);
}

function severityWeight(severity: string): number {
  switch (severity.toUpperCase()) {
    case 'CRITICAL':
      return 10;
    case 'HIGH':
      return 8;
    case 'ELEVATED':
    case 'MEDIUM':
      return 5;
    default:
      return 3;
  }
}

/**
 * USGS-style locations read "12km NE of Hakodate, Japan" — the tail after the
 * last comma is the coarse region an analyst would group by.
 */
function regionOf(location: string): string {
  const trimmed = location.trim();
  if (!trimmed) return 'Unattributed';
  const tail = trimmed.split(',').pop()?.trim();
  return tail && tail.length > 1 ? tail : trimmed;
}
