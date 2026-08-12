# OSIRIS

Open-source OSINT dashboard. Next.js 16 (App Router) + React 19 + Tailwind 4 +
TypeScript. Aggregates live intelligence feeds — earthquakes, aviation, maritime,
conflicts, cyber threats, markets, weather/GDACS, satellites — onto a map and
alert surface, with Gemini-backed summarisation on top.

## Commands

| Purpose | Command |
| --- | --- |
| Dev server | `npm run dev` |
| Build | `npm run build` |
| Test | `npm run test` (vitest) |
| Test with live APIs | `npm run test:live` (`RUN_LIVE_TESTS=1`) |
| Lint | `npm run lint` |

`node_modules` is not always present in fresh containers — run `npm install`
before assuming lint or test failures are real.

## Layout

```text
src/app/api/<domain>/route.ts   one route per data domain (~30 of them)
src/app/api/ai/                 analyze · briefing · overview
src/lib/ai-engine.ts            Gemini client, prompt assembly, key rotation
src/lib/ssrf-guard.ts           outbound fetch guard — see rules below
src/lib/stealthFetch.ts         upstream fetch wrapper
src/lib/sdk/                    LatticeAdapter, PolybolosClient
src/components/                 dashboard UI
intel/                          static reference data (read-only)
nginx/, Dockerfile, deploy.sh   deployment
orchestra/                      Claude Code → Codex orchestration (see below)
android/                        Claude Code on Android/Termux (see below)
docs/anthropic-academy/         agent harness architecture study notes (Korean)
```

## Rules specific to this repo

- **All outbound fetches go through `src/lib/ssrf-guard.ts`.** This is a user-facing
  dashboard that fetches URLs influenced by feed content. Do not add a bare
  `fetch()` to upstream data, and do not add a bypass parameter.
- **API routes need `export const dynamic = 'force-dynamic'`** or Next caches
  intelligence data that must be live.
- **Every new data-source route needs rate limiting.** Follow the pattern in
  `src/app/api/ai/analyze/route.ts` (per-IP window, in-memory map).
- **`src/lib/ai-engine.ts` uses Google Gemini.** Do not mix in another provider
  without deciding that explicitly — key rotation and error classification are
  built around one provider's error shapes.
- **Never log prompt or response bodies.** They carry OSINT feed content.
  Log structured metadata (endpoint, latency, outcome, error class) instead.
- **Never expose API keys to the client bundle.** No `NEXT_PUBLIC_` variable may
  hold a credential.
- **`intel/` is read-only reference data.** Do not write to it at runtime.
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
