# AIxCC Open Source Archive Registry

OSIRIS ships a machine-readable index of every code repository published through the
[DARPA AI Cyber Challenge competition archive](https://archive.aicyberchallenge.com).

The archive is the public release of the AIxCC final competition: all seven finalist
Cyber Reasoning Systems, the infrastructure they ran against, and the open source
projects used as competition targets. This registry records where that code lives so it
can be resolved, cloned, and cross-referenced from the Cyber domain.

**This is an index, not a mirror.** No AIxCC source is vendored into this repository —
each entry points at the upstream repository, which carries its own license.

## Contents

| Kind | Count | What it is |
|------|-------|------------|
| `crs` | 7 | Finalist Cyber Reasoning Systems, each released for both competition rounds |
| `infra` | 5 | Competition API, example CRS architecture, SHERPA, scoring pipeline, archive site |
| `challenge` | 24 | Open source projects used as final-round targets |

That is **42 distinct repositories** across 43 releases — Shellphish publishes both of
its rounds as tags on a single repository rather than two repositories.

### Cyber Reasoning Systems

| System | Team | Placement |
|--------|------|-----------|
| Atlantis | Team Atlanta | 1 |
| Buttercup | Trail of Bits | 2 |
| RoboDuck | Theori | 3 |
| Artiphishell | Shellphish | — |
| Fuzzing Brain | All You Need Is A Fuzzing Brain | — |
| Bug Buster | 42 b3yond 6ug | — |
| Lacrosse | Lacrosse | — |

### Challenge targets

The 24 target projects carry 48 challenge variants and 63 documented vulnerabilities
between them. Wireshark is the largest target (7 variants, 12 vulnerabilities), followed
by PDFBox (2 variants, 9 vulnerabilities) and Apache POI (2 variants, 7 vulnerabilities).

## Using it

```ts
import { AIXCC_REGISTRY, allRepos, registryStats } from '@/lib/aixcc-registry';

registryStats();  // { entries: 36, repos: 42, crs: 7, infra: 5, challenges: 24, ... }
allRepos();       // ['42-b3yond-6ug/42-b3yond-6ug-asc', ...] — sorted, deduplicated
```

### API

`GET /api/aixcc` returns the whole registry with resolved web and clone URLs. It is
static by construction, so it answers without a network round trip.

| Query | Effect |
|-------|--------|
| `?kind=crs` \| `infra` \| `challenge` | Filter by entry kind; an unknown kind is a 400 |
| `?q=<substring>` | Case-insensitive match over name, team, summary, and repo slug |

```bash
curl 'http://localhost:3000/api/aixcc?kind=crs'
curl 'http://localhost:3000/api/aixcc?q=wireshark'
```

Each release in the response carries a `url` (the tag page for tagged releases, the repo
root otherwise) and a `cloneUrl`.

## Verifying the registry

Unit tests cover the registry's shape and the URL helpers. A live test resolves every
registered repository against its real git remote, opt-in so the default suite stays
offline:

```bash
npm test                      # shape and helpers only
RUN_LIVE_TESTS=1 npm test     # additionally resolves all 42 remotes
```

Run the live test after editing the registry — it is what catches a repository that was
renamed, moved, or unpublished upstream.

## Provenance

Entry names, repository slugs, and challenge counts were derived from the archive site's
own source repository (`AIxCyberChallenge/archive`), and every repository slug was
resolved against its live git remote at the time of writing.
