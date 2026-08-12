/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Intel Wiki Types
 * ═══════════════════════════════════════════════════════════════
 */

import type { SchemaNode } from '@/lib/llm';

export type Confidence = 'high' | 'moderate' | 'low';

export interface WikiSource {
  label: string;
  url?: string;
}

/** Everything about an entry except the prose body. Serialised as frontmatter. */
export interface WikiMeta {
  slug: string;
  title: string;
  summary: string;
  tags: string[];
  confidence: Confidence;
  sources: WikiSource[];
  /** Bumped only when the content actually changes. */
  revision: number;
  /** Hash of the semantic content — the idempotency key for writes. */
  contentHash: string;
  createdAt: string;
  updatedAt: string;
  generatedBy: { provider: string; model: string; runId: string };
}

export interface WikiEntry extends WikiMeta {
  body: string;
}

/** What the model is asked to produce. Deliberately narrower than WikiEntry:
 *  revision, hashes and timestamps are the store's business, not the model's. */
export interface GeneratedEntry {
  title: string;
  summary: string;
  body: string;
  tags: string[];
  confidence: Confidence;
  sources: WikiSource[];
}

export const GENERATED_ENTRY_SCHEMA: SchemaNode = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'summary', 'body', 'tags', 'confidence', 'sources'],
  properties: {
    title: { type: 'string', description: 'Entry title', minLength: 3, maxLength: 120 },
    summary: {
      type: 'string',
      description: 'One or two sentences a reader can act on',
      minLength: 20,
      maxLength: 600,
    },
    body: {
      type: 'string',
      description: 'Markdown body with ## sections. No H1 — the title supplies it.',
      minLength: 80,
    },
    tags: {
      type: 'array',
      description: 'Lowercase topical tags',
      items: { type: 'string', minLength: 2, maxLength: 40 },
      minItems: 1,
      maxItems: 10,
    },
    confidence: {
      type: 'string',
      description: 'Assessed confidence given the supplied signals',
      enum: ['high', 'moderate', 'low'],
    },
    sources: {
      type: 'array',
      description: 'Only signals actually supplied in the context — never invent citations',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['label'],
        properties: {
          label: { type: 'string', minLength: 2, maxLength: 200 },
          url: { type: 'string', maxLength: 500 },
        },
      },
      maxItems: 20,
    },
  },
};

/* ─────────────────────────────────────────────────────────────
   Signals — the evidence a topic is built from
   ───────────────────────────────────────────────────────────── */

export interface Signal {
  id: string;
  label: string;
  detail: string;
  url?: string;
  observedAt: string;
  /** 0–10; used to order and trim the context window. */
  weight: number;
}

export interface Topic {
  slug: string;
  title: string;
  /** Free-form guidance appended to the generation prompt. */
  focus?: string;
  signals: Signal[];
}
