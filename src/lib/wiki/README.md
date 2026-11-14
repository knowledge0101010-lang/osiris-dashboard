# Intel Wiki Loop

A self-maintaining reference wiki built on the [LLM harness](../llm/README.md).
Feeds in, markdown entries out, regenerated only when something actually changed.

```bash
npm run wiki -- --context intel.json            # derive topics from live context
npm run wiki -- --topics topics.json --dry-run  # see what would be regenerated
npm run wiki -- --topics topics.json --provider mock --json
```

## The pass

```
IntelligenceContext ──▶ deriveTopics ──▶ Topic[] (slug, title, signals)
                                            │
                                            ▼
                              ┌── select ───────────────────┐
                              │  no entry yet      → build  │
                              │  older than TTL    → build  │
                              │  signal newer than          │
                              │    last write      → build  │
                              │  otherwise         → skip   │
                              │  past run cap      → skip   │
                              └──────────┬──────────────────┘
                                         ▼
                              runAgent (schema-constrained)
                                         ▼
                              store.write → created | updated | unchanged
```

## Why it is built this way

**Writes are content-addressed.** `contentHash` covers title, summary, body, tags,
confidence and sources — normalised, with tags and sources order-insensitive. If a
regeneration reproduces the same content the file is left alone: `revision` and
`updatedAt` do not move. Git history then records real editorial change rather
than how often the loop ran.

**Staleness is TTL *or* signal-driven.** An entry ages out after `ttlMs`, but a
signal observed after the last write invalidates it immediately. Breaking news does
not wait for a timer.

**Failure is isolated per topic.** A malformed answer or an exhausted budget on one
topic must not cost the others their turn, so each is caught, recorded in the
report, and the loop moves on. The runner exits `2` when anything failed.

**The model does not own metadata.** It returns only `title`, `summary`, `body`,
`tags`, `confidence` and `sources`. Revisions, hashes, timestamps and provenance are
the store's business — a model cannot invent a revision number or backdate an entry.

**Sources cannot be invented.** The prompt permits citing only the signals supplied,
and `confidence` is required to reflect the evidence actually present. Thin signals
must produce `"low"`.

**Signals are weight-ordered before truncation.** When a topic has more signals than
the context budget allows, the ones dropped are the least useful.

## Storage format

`content/wiki/<slug>.md` — JSON frontmatter, then the rendered body:

```
---
{
  "slug": "region-kuril-islands",
  "title": "Regional situation: Kuril Islands",
  "summary": "...",
  "tags": ["seismic", "pacific"],
  "confidence": "moderate",
  "sources": [{ "label": "USGS M5.4 event", "url": "https://..." }],
  "revision": 3,
  "contentHash": "492b03bb2f266bb4",
  "createdAt": "2026-08-01T00:00:00.000Z",
  "updatedAt": "2026-08-12T00:06:09.083Z",
  "generatedBy": { "provider": "gemini", "model": "gemini-2.0-flash", "runId": "run_ab12cd34" }
}
---

# Regional situation: Kuril Islands

## Observed
...
```

Frontmatter is JSON rather than YAML on purpose: it round-trips exactly, needs no
parser dependency, and cannot silently coerce a value the way YAML does. The H1 is
presentation only — parsing strips it so round-trips do not stack copies of the title.

## Serving

`GET /api/wiki` returns the index (metadata only), `?slug=` a single entry with its
body, `?tag=` a filtered index. Read-only by design: entries are written by the loop
and committed, never mutated over HTTP. Slugs are validated against `^[a-z0-9][a-z0-9-]{0,79}$`
before touching the filesystem.

## Runner flags

| Flag | Default | Meaning |
| --- | --- | --- |
| `--provider gemini\|mock` | `gemini` | Model backend; `mock` runs the whole loop offline |
| `--model <id>` | `gemini-2.0-flash` | Gemini model |
| `--dir <path>` | `content/wiki` | Wiki directory |
| `--topics <path>` | — | JSON `Topic[]` |
| `--context <path>` | — | JSON `IntelligenceContext` to derive topics from |
| `--ttl-hours <n>` | `24` | Regenerate entries older than this |
| `--limit <n>` | `10` | Max topics regenerated per run — the run's spend ceiling |
| `--max-steps <n>` | `4` | Per-topic provider round-trips |
| `--dry-run` | off | Select and report, call nothing |
| `--json` | off | Emit the run report as JSON |

Exit codes: `0` ok · `1` usage/config error · `2` one or more topics failed.

Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) for the real provider.

## Module resolution

`src/lib` is written for the Next.js bundler — `@/*` aliases, extensionless imports —
which Node's ESM resolver does not understand. The runner registers
`tools/wiki/src/loader.mjs` to translate those specifiers rather than forcing `.ts`
extensions on the whole app. Node ≥ 22.6 strips the types once a file resolves, so
there is no build step.
