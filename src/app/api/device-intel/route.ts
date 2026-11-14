/**
 * ═══════════════════════════════════════════════════════════════
 *  OSIRIS — Device Intel
 *  POST /api/device-intel   body: { input: string }
 *
 *  Analyses a smartphone's own reported state: a pasted "About phone"
 *  screen, an `adb shell getprop` dump, `dumpsys battery`, or a
 *  `pm list packages -3` listing — in any combination.
 *
 *  Entirely offline. Nothing is forwarded to a third party, nothing is
 *  persisted, and hardware identifiers (IMEI, serial, ICCID, MAC, phone
 *  number, e-mail) are stripped before analysis so they can never appear
 *  in the response.
 * ═══════════════════════════════════════════════════════════════
 */

import { NextRequest, NextResponse } from 'next/server';
import { analyzeDeviceText } from '@/lib/device-intel';

export const dynamic = 'force-dynamic';

/** Generous enough for a full getprop + package list, small enough to be safe. */
const MAX_INPUT_BYTES = 512 * 1024;

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const input = (body as { input?: unknown })?.input;
  if (typeof input !== 'string' || input.trim().length === 0) {
    return NextResponse.json(
      { error: 'Missing "input": paste device info text, a getprop dump, or both.' },
      { status: 400 },
    );
  }

  if (Buffer.byteLength(input, 'utf8') > MAX_INPUT_BYTES) {
    return NextResponse.json(
      { error: `Input too large (max ${MAX_INPUT_BYTES / 1024} KB).` },
      { status: 413 },
    );
  }

  try {
    const report = analyzeDeviceText(input);
    return NextResponse.json(report, {
      headers: { 'Cache-Control': 'no-store' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Analysis failed', detail: error instanceof Error ? error.message : String(error) },
      { status: 500 },
    );
  }
}

export async function GET() {
  return NextResponse.json(
    {
      endpoint: '/api/device-intel',
      method: 'POST',
      body: { input: 'string — pasted device info / getprop / dumpsys battery / pm list packages' },
      notes: [
        'Offline analysis; no outbound requests, no storage.',
        'Hardware identifiers are redacted before analysis.',
      ],
    },
    { status: 405, headers: { Allow: 'POST' } },
  );
}
