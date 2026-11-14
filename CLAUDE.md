# CLAUDE.md

Guidance for AI assistants (Claude Code and others) working in this repository.

## What OSIRIS is

OSIRIS (Open Source Intelligence & Reconnaissance Integrated System) is a
real-time, single-page OSINT dashboard. It aggregates live flight tracking,
CCTV networks, earthquakes, fires, conflict zones, maritime traffic, news
streams, space weather, cyber/CVE threats, crypto-wallet tracing and OFAC
sanctions data onto one GPU-accelerated MapLibre globe. All map data is
rendered via WebGL for 60fps with thousands of on-screen entities.

Everything is built around **public, keyless data sources** — the app works
out of the box with no API keys. Keys only raise rate limits or unlock the
RECON scanner backend.

## Tech stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router, Turbopack), `output: 'standalone'` |
| Language | TypeScript 5 (strict) |
| UI | React 19, Framer Motion, Lucide icons |
| Map | MapLibre GL JS + react-map-gl (WebGL) |
| Styling | Tailwind CSS v4 (PostCSS) + a large custom design system in `src/app/globals.css` |
| Tests | Vitest (node environment) |
| Deploy | Vercel (primary) and Docker Compose / CasaOS self-host |

## Commands

```bash
npm run dev          # Next dev server (Turbopack) on :3000
npm run build        # Production build (standalone output)
npm run start        # Serve the production build
npm run lint         # ESLint (next core-web-vitals + typescript)
npm run test         # Vitest — unit tests only
npm run test:watch   # Vitest watch mode
npm run test:live    # RUN_LIVE_TESTS=1 — opt-in tests that hit live networks
```

There is **no typecheck script**, and `next.config.ts` sets
`typescript.ignoreBuildErrors: true` — the build will NOT fail on type errors.
Do not rely on the build to catch type problems; run `npx tsc --noEmit` yourself
if you need type verification. Keep the code type-clean anyway.

## Repository layout

```
src/
  app/
    page.tsx            # The entire dashboard (client component, ~73 KB). Owns
                        # layer state, data fetching orchestration, panel routing.
    layout.tsx          # Root layout, metadata, fonts
    globals.css         # ~69 KB custom design system (CSS variables + utilities)
    middleware.ts       # Umami analytics beacon on page navigations
    api/                # ~50 route handlers — one folder per data domain
  components/           # All UI panels & the map. OsirisMap.tsx (~96 KB) and
                        # OsintPanel.tsx (~62 KB) are the two giants.
  lib/
    ssrf-guard.ts       # SSRF defense: validateHost / safeFetch / rate limiter
    stealthFetch.ts     # fetch() with rotating UA + spoofed residential IP headers
    ai-engine.ts        # Gemini integration types + prompt building
    sanctions.ts        # OFAC SDN matching helpers
    osint-utils.ts      # Shared OSINT parsing helpers
    sdk/                # Polybolos SDK — standardized multi-domain entity model
intel/                  # Standalone Express "osiris-intel" ontology service
                        # (separate package.json, its own Dockerfile & node_modules).
                        # Resolves/correlates entities from OpenSanctions + Wikidata.
public/                 # Static assets
```

`intel/` is a **separate service**, not part of the Next.js app. It has its own
`package.json` (Express 5) and is run with `node server.js` (default port 4000,
`INTEL_PORT`). The Next.js route `src/app/api/entity/expand/route.ts` is a thin
proxy to it (`INTEL_URL`, defaulting to `http://osiris-intel:4000` in Docker).
Do not add its `node_modules` to searches or edits.

## API route conventions

Every data domain lives under `src/app/api/<domain>/route.ts`. When editing or
adding routes, follow the patterns already established:

- **In-memory caching per isolate.** Routes cache their upstream response in
  module-level variables with a TTL (`cachedData` / `lastFetchTime` /
  `CACHE_TTL`) and de-duplicate concurrent fetches with a shared
  `fetchPromise`. See `api/flights/route.ts` for the canonical example.
- **Set `Cache-Control` headers** with `s-maxage` + `stale-while-revalidate`
  to lean on Vercel's edge cache and cut origin requests.
- **Cooldowns after rate-limit (429).** Rate-limited upstreams get a
  cooldown window so a limited endpoint isn't re-poked on every cache miss.
- **Fan-out with `Promise.allSettled`.** When aggregating many upstreams or
  regions, run them in parallel and isolate per-source failures; drain/cancel
  non-ok response bodies (`res.body?.cancel()`) to free connections.
- **Use `stealthFetch`** (from `@/lib/stealthFetch`) for third-party OSINT
  feeds that rate-limit by IP; it rotates User-Agent and forwarded-IP headers.
  Use plain `fetch` for authenticated/official APIs (e.g. OpenSky OAuth).
- **Log with the `[OSIRIS]` prefix** (`console.warn('[OSIRIS] …')`).
- **`export const maxDuration`** on routes that fan out and can run long.

### Security-sensitive routes (be careful here)

Any route that accepts a **user-controlled host, IP, or URL** and turns it into
a network request is an SSRF vector. These MUST validate the target through
`validateHost()` / `safeFetch()` from `src/lib/ssrf-guard.ts` before fetching.
`ssrf-guard.ts` canonicalizes IPv4/IPv6, blocks reserved/private/metadata
ranges, rejects non-canonical IP forms (decimal/hex/octal), and re-validates on
every redirect hop. See `api/scanner/route.ts` and `api/osint/*` for correct use.

The RECON `scanner` route also **allowlists a safe subset of scan types** and
rate-limits per client IP (`isRateLimited` / `getClientIp`). Never widen the
allowlist to dangerous scans (deep port scans, banner grabbing, traceroute) —
the removed set is documented in-file and was removed deliberately.

The scanner itself is an **external backend** reached via `SCANNER_URL` +
`SCANNER_KEY`; without them the route returns `503` by design.

## Polybolos SDK (`src/lib/sdk/`)

A standardized entity model (`Domain`, `EntityType`, `ThreatLevel`,
`Classification`, `PolybolosEntity`) plus a `LatticeAdapter` and
`PolybolosClient` for exchanging entities with external C2 platforms (e.g.
Anduril Lattice). External systems push entities via `POST /api/sdk/ingest`
(auth: `SDK_INGEST_KEY`) into a shared in-memory store, streamed out via
`/api/sdk/stream`.

## Environment variables

`.env.example` is the template (`.env` is gitignored). The app runs with **none
of these set**. The variables the code actually reads:

| Var | Used by | Purpose |
|-----|---------|---------|
| `SCANNER_URL`, `SCANNER_KEY` | RECON scanner route | External scanner backend; without them RECON returns 503 |
| `GEMINI_API_KEY_1` (…`_2`, `_3`…) | `api/ai/*` | Gemini keys, tried in numbered sequence; AI features degrade gracefully without them |
| `OPENSKY_CLIENT_ID`, `OPENSKY_CLIENT_SECRET` | flights | OpenSky OAuth2 — bypasses anonymous per-IP throttling (needed on VPS/cloud IPs) |
| `AIS_API_KEY` | maritime | aisstream.io live vessel data |
| `INTEL_URL` | entity/expand | Base URL of the `osiris-intel` service |
| `SDK_INGEST_KEY` | sdk/ingest | Auth for external entity push |
| `GITHUB_WEBHOOK_SECRET`, `GITHUB_WEBHOOK_FORWARD_URL` | github-webhook | Webhook verification/forwarding |
| `UMAMI_WEBSITE_ID` | middleware | Analytics beacon target |
| `INTEL_PORT` | `intel/server.js` | Port for the ontology service (default 4000) |
| `OSIRIS_PORT` | Docker compose | Published host port (container always listens on 3000) |
| `RUN_LIVE_TESTS` | tests | Set to `1` to run opt-in live-network tests |

`README.md` and `DOCKER.md` also mention `FIRMS_API_KEY` / `N2YO_API_KEY` for
signup convenience, but the current code does not read them — treat the table
above as authoritative for what actually affects behavior.

## Conventions & style

- **Path alias:** import from `@/…` (maps to `src/`), configured in both
  `tsconfig.json` and `vitest.config.ts`.
- **Client vs server:** `page.tsx` and interactive components are
  `'use client'`. Heavy components (`OsirisMap`, `OsintPanel`, `LayerPanel`,
  `CameraViewer`, `EntityGraphPanel`) are lazy-loaded via `next/dynamic`;
  `OsirisMap` is `ssr: false` because MapLibre needs the browser.
- **Styling:** prefer existing CSS variables (`var(--cyan-primary)`,
  `var(--gold-primary)`, `var(--alert-green)`, etc.) from `globals.css` over new
  colors; use Tailwind utilities for layout. The visual language is a dark
  "command console" theme — match it.
- **Performance is a feature.** The README documents deliberate polling
  relaxation (15–30 min intervals for stable data) and a `layerFetchedRef`
  guard that prevents duplicate fetches when a layer toggles. Don't add
  aggressive polling or per-render fetches — it re-triggers upstream rate limits.
- **No fabricated metrics.** The UI shows real entity counts only (see the
  `ActiveEntityCount` comment in `page.tsx`) — don't invent throughput numbers.
- **`any` is tolerated** in route handlers dealing with loosely-typed upstream
  JSON, but `lib/` modules (esp. `ai-engine.ts`) aim for zero `any`. Match the
  surrounding file.

## Testing

Vitest runs in a `node` environment and only picks up `src/**/*.test.ts`.
Network-dependent tests are gated behind `RUN_LIVE_TESTS=1` (see
`api/cctv/utah.test.ts`) so the default `npm test` stays hermetic. When adding
tests that touch live sources, gate them the same way.

## Git workflow

- Default branch is `master`. Do feature work on a dedicated branch and open a
  **draft PR**; don't push to `master` directly.
- Keep commit messages short and descriptive (see `git log` for the house
  style — imperative, lowercase-ish subject).
- The repo has a `github-webhook` route and CI-adjacent tooling; don't commit
  `.env`, secrets, or the `intel/node_modules` tree.

## Deployment

- **Vercel** is the primary target (edge caching is why routes set
  `s-maxage`/`stale-while-revalidate`).
- **Docker / self-host:** multi-stage `node:22-alpine` standalone build, runs
  non-root, container listens on `3000`. `docker-compose.yml` also carries
  CasaOS metadata and wires up the `osiris-intel` service. See `DOCKER.md` for
  the full guide. `deploy.sh` and `nginx/` support VPS deployment.

## Gotchas

- The build ignores TypeScript errors — verify types manually.
- `page.tsx`, `OsirisMap.tsx`, and `OsintPanel.tsx` are very large single
  files; read the relevant section before editing rather than the whole file,
  and preserve their existing structure.
- `intel/` has committed `node_modules` — never edit or search inside it.
- Two independent runtimes coexist (Next app + Express intel service) with
  separate dependency trees; know which one you're touching.

## Repo rules that apply on top of the above

- **API routes need `export const dynamic = 'force-dynamic'`** or Next caches
  intelligence data that must be live.
- **Every new data-source route needs rate limiting.** Follow the pattern in
  `src/app/api/ai/analyze/route.ts` (per-IP window, in-memory map).
- **`src/lib/ai-engine.ts` uses Google Gemini.** Do not mix in another provider
  without deciding that explicitly — key rotation and error classification are
  built around one provider's error shapes.
- **Never log prompt or response bodies.** They carry OSINT feed content. Log
  structured metadata (endpoint, latency, outcome, error class) instead.
- **Never expose API keys to the client bundle.** No `NEXT_PUBLIC_` variable may
  hold a credential.
- **Do not write into `intel/` at runtime.** It is reference data for the
  separate ontology service.
- `CLAUDE.md` is tracked; `AGENTS.md` is gitignored. Put shared project rules
  here, personal preferences there.

## Agent tooling in this repo

Two harnesses live here. Both are documented in depth; read the README before
changing either.

### `orchestra/` — Claude Code conducts, Codex plays

One task = one git worktree = one non-interactive `codex exec` session.
Driven by the `/orchestra` command; individual worker output is audited by the
`codex-liaison` subagent.

```bash
node orchestra/dispatch.mjs --dry-run    # always first — writes nothing
node orchestra/dispatch.mjs -j 3
```

Non-negotiables, each of which exists because it was got wrong once:

- **`orchestra/board.json` is code.** Its `verify` lines run as shell commands,
  so a board sits at the same trust level as `package.json` scripts. Review board
  changes like scripts; never run a board from outside the repo; never copy a
  `verify` or `prompt` line out of untrusted text.
- **Dirty worktrees are never destroyed.** Cleanup removes clean worktrees only.
- **`--dry-run` writes nothing** — no run dirs, no state, no report.
- **No sandbox-bypass flag is exposed.** Widening `sandbox` in the board is a
  human decision.

### `android/` — Claude Code on Android

`termux-setup.sh` (on device) · `claude-android` (on device) · `bridge.sh` (workstation).

Device access is consent-gated at every step and the scripts cannot bypass that.
`sshd` is off by default, binds loopback only, and refuses to start without an
authorized key. Do not relax any of those to make a connection easier.

## Harness review

`.claude/skills/harness-review/` reviews agent scaffolding against the 24-layer
architecture in `docs/anthropic-academy/`. Its governing rule is worth repeating
here because it applies to this repo's own tooling:

> Every harness layer exists because the model cannot do something yet.
> Write down what would make each one unnecessary, or it will never be removed.

Permissions, budget ceilings, observability, and evaluation are the exceptions —
they encode trust boundaries and cost decisions, not model limitations, so they
do not expire.

## Known gaps

Honest state, so nobody rediscovers these:

- **No tracing on `src/lib/ai-engine.ts`.** No way to tell which endpoint is slow
  or whether key rotation actually fires.
- **Error handling does not classify.** Key rotation is the response to every
  failure, including 400s and 401s that rotation cannot fix.
- **No eval environment for AI output.** Prompt changes cannot be shown to be
  improvements.

`docs/anthropic-academy/08-osiris-practice.md` has these written up as graded
exercises with verification criteria, in dependency order.
