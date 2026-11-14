import { NextResponse } from 'next/server';
import {
  AIXCC_ARCHIVE_URL,
  AIXCC_REGISTRY,
  registryStats,
  releaseUrl,
  repoUrl,
  type AixccEntry,
  type AixccKind,
} from '@/lib/aixcc-registry';

/**
 * OSIRIS — AIxCC Open Source Archive
 *
 * Serves the registry of every code repository published through the DARPA AI Cyber
 * Challenge archive. Static by construction, so it answers without a network round
 * trip; filter with `?kind=crs|infra|challenge` or `?q=<substring>`.
 */

const KINDS: AixccKind[] = ['crs', 'infra', 'challenge'];

function isKind(value: string | null): value is AixccKind {
  return value !== null && (KINDS as string[]).includes(value);
}

function matches(entry: AixccEntry, query: string): boolean {
  const haystack = [entry.name, entry.team ?? '', entry.summary, ...entry.releases.map((r) => r.repo)]
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const kind = params.get('kind');
  const query = params.get('q')?.trim().toLowerCase();

  if (kind !== null && !isKind(kind)) {
    return NextResponse.json(
      { error: `Unknown kind '${kind}'. Expected one of: ${KINDS.join(', ')}.` },
      { status: 400 },
    );
  }

  let entries = AIXCC_REGISTRY;
  if (isKind(kind)) entries = entries.filter((e) => e.kind === kind);
  if (query) entries = entries.filter((e) => matches(e, query));

  return NextResponse.json({
    source: AIXCC_ARCHIVE_URL,
    stats: registryStats(),
    matched: entries.length,
    entries: entries.map((entry) => ({
      ...entry,
      releases: entry.releases.map((release) => ({
        ...release,
        url: releaseUrl(release),
        cloneUrl: `${repoUrl(release.repo)}.git`,
      })),
    })),
    timestamp: new Date().toISOString(),
  });
}
