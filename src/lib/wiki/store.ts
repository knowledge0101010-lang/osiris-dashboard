/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Wiki Store
 *  Markdown on disk, JSON frontmatter, content-addressed writes.
 *
 *  Frontmatter is JSON rather than YAML on purpose: it round-trips
 *  exactly, needs no parser dependency, and cannot silently coerce
 *  a value the way YAML does.
 * ═══════════════════════════════════════════════════════════════
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { GeneratedEntry, WikiEntry, WikiMeta } from './types';

export const DEFAULT_WIKI_DIR = 'content/wiki';
const DELIMITER = '---';

export type WriteOutcome = 'created' | 'updated' | 'unchanged';

export interface WriteResult {
  outcome: WriteOutcome;
  entry: WikiEntry;
  path: string;
}

/* ─────────────────────────────────────────────────────────────
   Slugs & hashing
   ───────────────────────────────────────────────────────────── */

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 80)
    .replace(/^-|-$/g, '');
  return slug || 'untitled';
}

/**
 * Hashes only what a reader would notice. Timestamps and revisions are
 * excluded so a re-run that produces identical prose is a no-op.
 */
export function contentHash(entry: GeneratedEntry): string {
  const canonical = JSON.stringify({
    title: entry.title.trim(),
    summary: entry.summary.trim(),
    body: entry.body.trim(),
    tags: [...entry.tags].map((tag) => tag.trim().toLowerCase()).sort(),
    confidence: entry.confidence,
    sources: [...entry.sources]
      .map((source) => ({ label: source.label.trim(), url: source.url?.trim() ?? '' }))
      .sort((a, b) => (a.label + a.url).localeCompare(b.label + b.url)),
  });
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/* ─────────────────────────────────────────────────────────────
   Serialisation
   ───────────────────────────────────────────────────────────── */

export function serialize(entry: WikiEntry): string {
  const { body, ...meta } = entry;
  return `${DELIMITER}\n${JSON.stringify(meta, null, 2)}\n${DELIMITER}\n\n# ${entry.title}\n\n${body.trim()}\n`;
}

export function parse(raw: string): WikiEntry {
  if (!raw.startsWith(`${DELIMITER}\n`)) {
    throw new Error('Wiki entry is missing its frontmatter block.');
  }
  const end = raw.indexOf(`\n${DELIMITER}`, DELIMITER.length);
  if (end === -1) throw new Error('Wiki entry frontmatter is unterminated.');

  const meta = JSON.parse(raw.slice(DELIMITER.length + 1, end + 1)) as WikiMeta;
  const rest = raw.slice(end + DELIMITER.length + 2);
  // Drop the rendered H1 — the title lives in frontmatter and would otherwise duplicate.
  const body = rest.replace(/^\s*#\s+.*\n/, '').trim();
  return { ...meta, body };
}

/* ─────────────────────────────────────────────────────────────
   Store
   ───────────────────────────────────────────────────────────── */

export interface WikiStoreOptions {
  dir?: string;
  now?: () => Date;
}

export class WikiStore {
  readonly dir: string;
  private readonly now: () => Date;

  constructor(options: WikiStoreOptions = {}) {
    this.dir = options.dir ?? DEFAULT_WIKI_DIR;
    this.now = options.now ?? (() => new Date());
  }

  pathFor(slug: string): string {
    return join(this.dir, `${slug}.md`);
  }

  async listSlugs(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    return names
      .filter((name) => name.endsWith('.md'))
      .map((name) => name.slice(0, -3))
      .sort();
  }

  async read(slug: string): Promise<WikiEntry | undefined> {
    try {
      return parse(await readFile(this.pathFor(slug), 'utf8'));
    } catch (error) {
      if (isNotFound(error)) return undefined;
      throw error;
    }
  }

  async readAll(): Promise<WikiEntry[]> {
    const slugs = await this.listSlugs();
    const entries = await Promise.all(slugs.map((slug) => this.read(slug)));
    return entries.filter((entry): entry is WikiEntry => entry !== undefined);
  }

  /**
   * Writes an entry, but only if its content actually differs. An unchanged
   * regeneration leaves the file — and its `updatedAt` — untouched, so the git
   * history stays a record of real change rather than of how often the loop ran.
   */
  async write(
    slug: string,
    generated: GeneratedEntry,
    provenance: { provider: string; model: string; runId: string },
  ): Promise<WriteResult> {
    const existing = await this.read(slug);
    const hash = contentHash(generated);
    const timestamp = this.now().toISOString();

    if (existing && existing.contentHash === hash) {
      return { outcome: 'unchanged', entry: existing, path: this.pathFor(slug) };
    }

    const entry: WikiEntry = {
      slug,
      title: generated.title.trim(),
      summary: generated.summary.trim(),
      body: generated.body.trim(),
      tags: generated.tags.map((tag) => tag.trim().toLowerCase()),
      confidence: generated.confidence,
      sources: generated.sources,
      revision: (existing?.revision ?? 0) + 1,
      contentHash: hash,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      generatedBy: provenance,
    };

    await mkdir(this.dir, { recursive: true });
    await writeFile(this.pathFor(slug), serialize(entry), 'utf8');
    return { outcome: existing ? 'updated' : 'created', entry, path: this.pathFor(slug) };
  }
}

/* ─────────────────────────────────────────────────────────────
   Staleness
   ───────────────────────────────────────────────────────────── */

export interface StalenessPolicy {
  /** Entries older than this are regenerated even with no new signals. */
  ttlMs: number;
}

/**
 * An entry is stale when it has aged past its TTL, or when a signal arrived
 * after it was last written — whichever comes first.
 */
export function isStale(
  entry: WikiEntry | undefined,
  options: { now: Date; policy: StalenessPolicy; latestSignalAt?: Date },
): boolean {
  if (!entry) return true;
  const updatedAt = Date.parse(entry.updatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  if (options.now.getTime() - updatedAt >= options.policy.ttlMs) return true;
  return options.latestSignalAt !== undefined && options.latestSignalAt.getTime() > updatedAt;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: string }).code === 'ENOENT'
  );
}
