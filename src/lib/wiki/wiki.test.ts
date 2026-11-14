import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { MockProvider, type ScriptedTurn } from '@/lib/llm';
import { WikiStore, contentHash, isStale, parse, serialize, slugify } from './store';
import { buildPrompt, runWikiLoop } from './loop';
import { deriveTopics } from './topics';
import type { GeneratedEntry, Topic } from './types';
import type { IntelligenceContext } from '@/lib/ai-engine';

const GENERATED: GeneratedEntry = {
  title: 'Kuril Islands seismic activity',
  summary: 'A cluster of moderate quakes over 48 hours, with no tsunami advisory issued.',
  body: '## Observed\nThree events above M5.\n\n## Assessment\nConsistent with routine subduction activity.',
  tags: ['seismic', 'pacific'],
  confidence: 'moderate',
  sources: [{ label: 'USGS M5.4 event', url: 'https://example.test/eq/1' }],
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'osiris-wiki-'));
});

function storeAt(now = '2026-08-12T00:00:00.000Z'): WikiStore {
  return new WikiStore({ dir, now: () => new Date(now) });
}

const PROVENANCE = { provider: 'mock', model: 'mock-model', runId: 'run_test' };

/* ═══════════════════════════════════════════ store ═══════════════════════════ */

describe('slugify', () => {
  it('produces url-safe slugs', () => {
    expect(slugify('Kuril Islands — Seismic Activity!')).toBe('kuril-islands-seismic-activity');
  });

  it('never returns an empty slug', () => {
    expect(slugify('!!!')).toBe('untitled');
  });
});

describe('serialize / parse', () => {
  it('round-trips an entry without drift', async () => {
    const written = await storeAt().write('kuril', GENERATED, PROVENANCE);
    const round = parse(serialize(written.entry));
    expect(round).toEqual(written.entry);
  });

  it('renders the title as an H1 that parsing strips again', async () => {
    const written = await storeAt().write('kuril', GENERATED, PROVENANCE);
    const raw = serialize(written.entry);
    expect(raw).toContain(`# ${GENERATED.title}`);
    // The H1 is presentation only; it must not leak back into the stored body,
    // or each round-trip would prepend another copy of the title.
    expect(parse(raw).body).toBe(GENERATED.body);
    expect(parse(raw).body.startsWith('# ')).toBe(false);
  });

  it('rejects a file with no frontmatter', () => {
    expect(() => parse('# Just a heading\n')).toThrow(/frontmatter/);
  });
});

describe('contentHash', () => {
  it('ignores ordering of tags and sources', () => {
    const reordered: GeneratedEntry = {
      ...GENERATED,
      tags: ['pacific', 'seismic'],
      sources: [...GENERATED.sources],
    };
    expect(contentHash(reordered)).toBe(contentHash(GENERATED));
  });

  it('changes when the body changes', () => {
    expect(contentHash({ ...GENERATED, body: `${GENERATED.body} More.` })).not.toBe(contentHash(GENERATED));
  });
});

describe('WikiStore.write', () => {
  it('creates an entry at revision 1', async () => {
    const result = await storeAt().write('kuril', GENERATED, PROVENANCE);
    expect(result.outcome).toBe('created');
    expect(result.entry.revision).toBe(1);
    expect(await readFile(result.path, 'utf8')).toContain('Kuril Islands seismic activity');
  });

  it('is a no-op when the content is identical', async () => {
    const store = storeAt();
    await store.write('kuril', GENERATED, PROVENANCE);
    const second = await storeAt('2026-09-01T00:00:00.000Z').write('kuril', GENERATED, PROVENANCE);

    expect(second.outcome).toBe('unchanged');
    expect(second.entry.revision).toBe(1);
    // A re-run that changed nothing must not look like an update.
    expect(second.entry.updatedAt).toBe('2026-08-12T00:00:00.000Z');
  });

  it('bumps the revision and preserves createdAt on a real change', async () => {
    await storeAt('2026-08-01T00:00:00.000Z').write('kuril', GENERATED, PROVENANCE);
    const second = await storeAt('2026-08-12T00:00:00.000Z').write(
      'kuril',
      { ...GENERATED, body: `${GENERATED.body}\n\n## Update\nA fourth event.` },
      PROVENANCE,
    );

    expect(second.outcome).toBe('updated');
    expect(second.entry.revision).toBe(2);
    expect(second.entry.createdAt).toBe('2026-08-01T00:00:00.000Z');
    expect(second.entry.updatedAt).toBe('2026-08-12T00:00:00.000Z');
  });

  it('lowercases tags on the way in', async () => {
    const result = await storeAt().write('kuril', { ...GENERATED, tags: ['Seismic', 'PACIFIC'] }, PROVENANCE);
    expect(result.entry.tags).toEqual(['seismic', 'pacific']);
  });
});

describe('WikiStore.read', () => {
  it('returns undefined for a missing slug', async () => {
    expect(await storeAt().read('nope')).toBeUndefined();
  });

  it('lists and reads back everything written', async () => {
    const store = storeAt();
    await store.write('a', GENERATED, PROVENANCE);
    await store.write('b', { ...GENERATED, title: 'Second' }, PROVENANCE);

    expect(await store.listSlugs()).toEqual(['a', 'b']);
    expect((await store.readAll()).map((entry) => entry.title)).toEqual(['Kuril Islands seismic activity', 'Second']);
  });

  it('surfaces a corrupt entry rather than silently dropping it', async () => {
    await writeFile(join(dir, 'broken.md'), 'no frontmatter here', 'utf8');
    await expect(storeAt().read('broken')).rejects.toThrow(/frontmatter/);
  });
});

/* ═══════════════════════════════════════ staleness ═══════════════════════════ */

describe('isStale', () => {
  const policy = { ttlMs: 24 * 60 * 60 * 1000 };
  const now = new Date('2026-08-12T00:00:00.000Z');

  it('treats a missing entry as stale', () => {
    expect(isStale(undefined, { now, policy })).toBe(true);
  });

  it('is fresh inside the TTL with no newer signal', async () => {
    const entry = (await storeAt('2026-08-11T23:00:00.000Z').write('k', GENERATED, PROVENANCE)).entry;
    expect(isStale(entry, { now, policy })).toBe(false);
  });

  it('goes stale past the TTL', async () => {
    const entry = (await storeAt('2026-08-10T00:00:00.000Z').write('k', GENERATED, PROVENANCE)).entry;
    expect(isStale(entry, { now, policy })).toBe(true);
  });

  it('goes stale when a signal lands after the last write', async () => {
    const entry = (await storeAt('2026-08-11T23:00:00.000Z').write('k', GENERATED, PROVENANCE)).entry;
    expect(isStale(entry, { now, policy, latestSignalAt: new Date('2026-08-11T23:30:00.000Z') })).toBe(true);
  });
});

/* ══════════════════════════════════════════ loop ═════════════════════════════ */

function topic(overrides: Partial<Topic> = {}): Topic {
  return {
    slug: 'kuril',
    title: 'Kuril Islands',
    signals: [
      {
        id: 's1',
        label: 'USGS M5.4',
        detail: 'Depth 40km',
        observedAt: '2026-08-11T22:00:00.000Z',
        weight: 5,
      },
    ],
    ...overrides,
  };
}

function jsonTurn(entry: GeneratedEntry = GENERATED): ScriptedTurn {
  return { kind: 'text', text: JSON.stringify(entry) };
}

const loopDeps = { now: () => 1_000, runId: () => 'run_test', retry: { sleep: async () => {}, random: () => 0.5 } };

describe('runWikiLoop', () => {
  it('creates an entry for a new topic', async () => {
    const store = storeAt();
    const report = await runWikiLoop({
      store,
      provider: new MockProvider({ script: [jsonTurn()] }),
      topics: [topic()],
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      harnessDeps: loopDeps,
    });

    expect(report.created).toBe(1);
    expect(report.outcomes[0]).toMatchObject({ slug: 'kuril', status: 'created', revision: 1 });
    expect((await store.read('kuril'))?.title).toBe(GENERATED.title);
  });

  it('skips a fresh topic without calling the model', async () => {
    const store = storeAt('2026-08-11T23:00:00.000Z');
    await store.write('kuril', GENERATED, PROVENANCE);
    const provider = new MockProvider({ script: [jsonTurn()] });

    const report = await runWikiLoop({
      store,
      provider,
      topics: [topic({ signals: [] })],
      now: () => new Date('2026-08-11T23:30:00.000Z'),
      harnessDeps: loopDeps,
    });

    expect(report.skipped).toBe(1);
    expect(provider.callCount).toBe(0);
  });

  it('regenerates when a signal is newer than the entry', async () => {
    const store = storeAt('2026-08-11T22:00:00.000Z');
    await store.write('kuril', GENERATED, PROVENANCE);

    const report = await runWikiLoop({
      store,
      provider: new MockProvider({ script: [jsonTurn({ ...GENERATED, body: `${GENERATED.body}\n\n## New\nMore.` })] }),
      topics: [topic({ signals: [{ ...topic().signals[0], observedAt: '2026-08-11T23:00:00.000Z' }] })],
      now: () => new Date('2026-08-11T23:30:00.000Z'),
      harnessDeps: loopDeps,
    });

    expect(report.updated).toBe(1);
  });

  it('reports "unchanged" when regeneration reproduces the same content', async () => {
    const store = storeAt('2026-08-10T00:00:00.000Z');
    await store.write('kuril', GENERATED, PROVENANCE);

    const report = await runWikiLoop({
      store,
      provider: new MockProvider({ script: [jsonTurn()] }),
      topics: [topic()],
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      harnessDeps: loopDeps,
    });

    expect(report.unchanged).toBe(1);
    expect(report.updated).toBe(0);
  });

  it('isolates a failing topic so the rest still run', async () => {
    const store = storeAt();
    // First topic gets unusable output with no repair budget; second gets valid JSON.
    const provider = new MockProvider({
      script: [{ kind: 'text', text: 'not json' }, { kind: 'text', text: 'still not json' }, jsonTurn()],
    });

    const report = await runWikiLoop({
      store,
      provider,
      topics: [topic({ slug: 'bad' }), topic({ slug: 'good' })],
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      harnessDeps: loopDeps,
    });

    expect(report.failed).toBe(1);
    expect(report.created).toBe(1);
    expect(await store.read('good')).toBeDefined();
    expect(await store.read('bad')).toBeUndefined();
  });

  it('honours the per-run topic cap', async () => {
    const report = await runWikiLoop({
      store: storeAt(),
      provider: new MockProvider({ script: [jsonTurn()] }),
      topics: [topic({ slug: 'a' }), topic({ slug: 'b' }), topic({ slug: 'c' })],
      maxTopicsPerRun: 2,
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      harnessDeps: loopDeps,
    });

    expect(report.selected).toBe(2);
    expect(report.outcomes.filter((o) => o.reason === 'run cap reached')).toHaveLength(1);
  });

  it('writes nothing on a dry run', async () => {
    const store = storeAt();
    const provider = new MockProvider({ script: [jsonTurn()] });

    const report = await runWikiLoop({
      store,
      provider,
      topics: [topic()],
      dryRun: true,
      now: () => new Date('2026-08-12T00:00:00.000Z'),
      harnessDeps: loopDeps,
    });

    expect(report.skipped).toBe(1);
    expect(provider.callCount).toBe(0);
    expect(await store.listSlugs()).toEqual([]);
  });
});

describe('buildPrompt', () => {
  it('orders signals by weight and truncates the tail', () => {
    const prompt = buildPrompt(
      topic({
        signals: [
          { id: 'a', label: 'low', detail: 'd', observedAt: '2026-08-11T00:00:00.000Z', weight: 1 },
          { id: 'b', label: 'high', detail: 'd', observedAt: '2026-08-11T00:00:00.000Z', weight: 9 },
        ],
      }),
      1,
    );

    expect(prompt).toContain('high');
    expect(prompt).not.toContain('low');
    expect(prompt).toContain('(1 of 2)');
  });

  it('tells the model to say so when there are no signals', () => {
    expect(buildPrompt(topic({ signals: [] }), 10)).toContain('None supplied');
  });
});

/* ════════════════════════════════════════ topics ═════════════════════════════ */

function context(overrides: Partial<IntelligenceContext> = {}): IntelligenceContext {
  return {
    timestamp: '2026-08-12T00:00:00.000Z',
    earthquakes: [],
    news: [],
    threats: [],
    cyberAlerts: [],
    ...overrides,
  } as IntelligenceContext;
}

describe('deriveTopics', () => {
  it('groups earthquakes into a regional topic', () => {
    const topics = deriveTopics(
      context({
        earthquakes: [
          {
            id: '1',
            magnitude: 5.4,
            location: '12km NE of Severo, Kuril Islands',
            latitude: 1,
            longitude: 2,
            depth: 40,
            timestamp: '2026-08-11T00:00:00.000Z',
            tsunami: false,
            felt: null,
            alert: null,
          },
          {
            id: '2',
            magnitude: 5.1,
            location: '30km S of Severo, Kuril Islands',
            latitude: 1,
            longitude: 2,
            depth: 35,
            timestamp: '2026-08-11T01:00:00.000Z',
            tsunami: false,
            felt: null,
            alert: null,
          },
        ],
      }),
    );

    expect(topics).toHaveLength(1);
    expect(topics[0].slug).toBe('region-kuril-islands');
    expect(topics[0].signals).toHaveLength(2);
  });

  it('drops topics with too few signals', () => {
    const topics = deriveTopics(
      context({
        cyberAlerts: [
          {
            id: 'CVE-1',
            name: 'RCE',
            vendor: 'v',
            product: 'p',
            severity: 'CRITICAL',
            date: '2026-08-11T00:00:00.000Z',
            due: '2026-08-20',
            source: 'CISA KEV',
          },
        ],
      }),
      { minSignals: 2 },
    );
    expect(topics).toEqual([]);
  });

  it('ranks topics by total signal weight', () => {
    const topics = deriveTopics(
      context({
        cyberAlerts: [
          { id: 'CVE-1', name: 'a', vendor: 'v', product: 'p', severity: 'CRITICAL', date: '2026-08-11T00:00:00.000Z', due: '2026-08-20', source: 'CISA KEV' },
          { id: 'CVE-2', name: 'b', vendor: 'v', product: 'p', severity: 'CRITICAL', date: '2026-08-11T00:00:00.000Z', due: '2026-08-20', source: 'CISA KEV' },
        ],
        news: [
          { id: 'n1', title: 't', description: 'd', link: 'https://x.test', published: '2026-08-11T00:00:00.000Z', source: 's', risk_score: 1, coords: null, machine_assessment: null },
          { id: 'n2', title: 't', description: 'd', link: 'https://x.test', published: '2026-08-11T00:00:00.000Z', source: 's', risk_score: 1, coords: null, machine_assessment: null },
        ],
      }),
    );

    expect(topics.map((t) => t.slug)).toEqual(['domain-cyber', 'domain-geopolitics']);
  });
});
