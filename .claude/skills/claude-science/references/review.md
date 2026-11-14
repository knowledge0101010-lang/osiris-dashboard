# The reviewer

`scripts/review.py` is a background referee: it reads a draft and refuses to let claims
travel without evidence. Run it before anything leaves the project.

```bash
review.py --manuscript draft.md
review.py --manuscript draft.md --bib refs.bib --online
review.py --manuscript paper.tex --json
```

## What it checks

### Figures and tables

Collects every path the draft references — Markdown images and links, `\includegraphics{}`,
and bare mentions of `figures/…`, `results/…`, `tables/…` — then for each one asks:

| Finding | Severity | Meaning |
|---|---|---|
| `figure-missing` | blocker | the referenced file is not there |
| `figure-unprovenanced` | blocker | it exists but has no manifest |
| `figure-drift` | blocker | its bytes, its code, or one of its inputs changed after recording |

`figure-drift` is the check that earns its keep. It catches the figure that was tweaked by
hand, and the figure that was made before an upstream file was fixed.

### Numbers

Every numeric claim in prose must trace to a recorded value (`provenance.py value`) or to a
number in a results table. A claim is accepted when some recorded number rounds to it at the
precision written — `2.4` matches a stored `2.413`; `2.5` does not.

Deliberately not flagged: numbers inside code fences and inline code, years, cross-references
(`Figure 2`, `Table 1`, `Section 3.1`), significance thresholds (`FDR < 0.05`, `p ≤ 0.01`),
DOIs, PMIDs, numbers inside URLs, and bare integers shorter than `--min-digits` (default 3).

`number-untraceable` is a warning, not a blocker, because prose legitimately contains
numbers from the literature. Each one is still a question to answer: either record the value,
or cite where it came from.

### Citations

| Finding | Severity | Meaning |
|---|---|---|
| `citation-missing-bib` | blocker (note without `--bib`) | `[@key]` has no entry in the bibliography |
| `citation-malformed` | blocker | a DOI that cannot be a DOI |
| `citation-unresolved` | blocker | with `--online`, a DOI (Crossref) or PMID (E-utilities) that does not resolve |

`--online` catches the failure mode that matters most in AI-assisted writing: a citation that
is well-formed, plausible, and does not exist. Run it at least once before submission.

A resolving DOI proves the paper exists — not that it says what you claim. That check is
still yours.

### Orphans

`artifact-orphan` (warning): a figure or table sitting in `figures/`, `results/`, `tables/`,
or `outputs/` with no manifest. Either record it or delete it; an unexplained file in the
results tree is a future misattribution.

## Options

| Flag | Effect |
|---|---|
| `--bib refs.bib` | resolve `[@key]` citations against a BibTeX file |
| `--online` | resolve DOIs and PMIDs over the network |
| `--data-dir results` | restrict which directories supply acceptable numbers and are scanned for orphans (repeatable) |
| `--min-digits N` | treat integers with fewer than N digits as prose, not claims |
| `--skip figures\|numbers\|citations\|orphans` | drop a check (repeatable) |
| `--json` | machine-readable findings |
| `--project DIR` | project root, if the draft lives elsewhere |

Exit status is 1 when any blocker is present — wire it into CI or a pre-commit hook next to
`provenance.py check`.

## Using it well

1. Run it early, while the draft is still a skeleton. Blockers are cheap to fix before the
   text hardens around them.
2. Fix, do not silence. `--skip` is for a check that does not apply to this document, not for
   a finding you would rather not deal with.
3. Report what it said. When handing over a draft, state the review outcome and any finding
   you consciously accepted, with the reason.
4. A clean review is a floor, not a ceiling. It says the numbers and figures are traceable.
   It says nothing about whether the analysis was the right one — that judgement stays with
   you.
