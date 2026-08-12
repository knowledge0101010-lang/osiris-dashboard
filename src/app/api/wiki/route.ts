/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Intel Wiki Endpoint
 *  GET /api/wiki            → entry index (metadata only)
 *  GET /api/wiki?slug=x     → a single entry with its body
 *  GET /api/wiki?tag=cyber  → index filtered by tag
 *
 *  Read-only by design: entries are written by the refresh loop
 *  (`npm run wiki`) and committed, never mutated over HTTP.
 * ═══════════════════════════════════════════════════════════════
 */

import { NextRequest, NextResponse } from 'next/server';
import { DEFAULT_WIKI_DIR, WikiStore, type WikiEntry } from '@/lib/wiki';

export const dynamic = 'force-dynamic';

const store = new WikiStore({ dir: process.env.WIKI_DIR ?? DEFAULT_WIKI_DIR });

/** Slugs are filenames; anything outside this shape is a traversal attempt. */
const SAFE_SLUG = /^[a-z0-9][a-z0-9-]{0,79}$/;

/** The index omits bodies: it exists to be listed, not to ship every entry's prose. */
function summarize(entry: WikiEntry): Omit<WikiEntry, 'body'> {
  const meta: Record<string, unknown> = { ...entry };
  delete meta.body;
  return meta as Omit<WikiEntry, 'body'>;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const slug = request.nextUrl.searchParams.get('slug');
  const tag = request.nextUrl.searchParams.get('tag')?.toLowerCase();

  try {
    if (slug) {
      if (!SAFE_SLUG.test(slug)) {
        return NextResponse.json({ success: false, error: 'Invalid slug.' }, { status: 400 });
      }
      const entry = await store.read(slug);
      if (!entry) {
        return NextResponse.json({ success: false, error: 'No such entry.' }, { status: 404 });
      }
      return NextResponse.json({ success: true, entry });
    }

    const entries = await store.readAll();
    const filtered = tag ? entries.filter((entry) => entry.tags.includes(tag)) : entries;

    return NextResponse.json({
      success: true,
      count: filtered.length,
      entries: filtered
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .map(summarize),
    });
  } catch (error) {
    return NextResponse.json(
      {
        success: false,
        error: 'Failed to read the wiki store.',
        hint: error instanceof Error ? error.message : undefined,
      },
      { status: 500 },
    );
  }
}
