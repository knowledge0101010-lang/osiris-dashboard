# Provenance

An artifact without provenance is a screenshot. This file specifies what gets recorded,
what the manifest means, and how to read a drift report.

## What counts as an artifact

Anything a reader could quote or a reviewer could ask about:

- figures (`.png`, `.pdf`, `.svg`)
- result tables (`.csv`, `.tsv`, `.xlsx`)
- derived datasets (a filtered `.h5ad`, a normalised matrix, an alignment)
- model checkpoints and fitted objects
- anything you would regenerate rather than re-derive by hand

Intermediate scratch files do not need manifests. If it leaves the project — into a
manuscript, a slide, a message to a collaborator — it needs one.

## Recording

```bash
provenance.py record \
  --artifact figures/fig3_volcano.png \
  --code steps/04_de.py \
  --input results/de_results.csv \
  --input data/sample_sheet.csv \
  --title "Volcano plot, tumour vs normal" \
  --note "Wald test, apeglm shrinkage, labels for |LFC| > 1 and padj < 0.01" \
  --kernel de
```

Repeat `--code` and `--input` freely. Directories are accepted and hashed as a sorted tree
of their file hashes. `--fast-hash` edge-hashes files over 16 MB (recorded as
`sha256-partial:`) — use it for multi-gigabyte inputs, never for the artifact itself.

Every `record` captures, without being asked:

| Field | Meaning |
|---|---|
| `artifact` | path, hash, byte size, mtime |
| `code` | each script's path, hash, line count, and the first 4 000 characters inline |
| `inputs` | path, hash, size for every declared input |
| `environment_ref` | hash of a snapshot in `.science/environments/` — interpreter, platform, host, conda/venv, full package list |
| `git` | commit, branch, remote, **dirty flag** and the dirty file list |
| `recorded_at` / `recorded_by` | UTC timestamp, `user@host` |
| `kernel` / `command` | which kernel or command line produced it |

The code snippet is stored inline on purpose: the manifest stays readable even if the repo
is later rearranged.

## Values quoted in prose

Never retype a number out of scroll-back. Record it where it is computed:

```bash
provenance.py value --key de_genes_fdr05 --value 1284 --unit genes \
  --code steps/04_de.py --note "Wald test, BH-adjusted"
provenance.py value --list
provenance.py value --get de_genes_fdr05
```

From inside a kernel, shell out at the moment of computation so the value cannot drift
from the code that made it:

```python
import subprocess
n = int((res.padj < 0.05).sum())
subprocess.run([PROV, "value", "--key", "de_genes_fdr05", "--value", str(n),
                "--code", "steps/04_de.py"], check=True)
```

`review.py` accepts a number in prose when a recorded value — or any number in a results
table — rounds to it at the precision you wrote. Writing `2.4` is fine when the stored value
is `2.413`; writing `2.5` is not.

## Checking

```bash
provenance.py check                 # every recorded artifact
provenance.py check figures/fig3_volcano.png
provenance.py check --quiet         # problems only
```

| Status | Meaning | Usual cause |
|---|---|---|
| `OK` | artifact and all dependencies match their hashes | — |
| `DRIFT` | artifact bytes changed since recording | regenerated without re-recording, or edited by hand |
| `DEP-DRIFT` | an input or script changed after the run | the figure is now older than its inputs |
| `MISSING` | the artifact is gone | moved or deleted without re-recording |
| `DEP-MISSING` | an input or script is gone | deleted, renamed, or never committed |
| `NO-MANIFEST` | ledger mentions it but no manifest survives | `.science/` partially deleted |

`check` exits non-zero if anything is wrong, so it drops straight into a pre-commit hook or
CI step.

**A drift report is not noise.** It means a result on disk and the code that supposedly made
it have parted ways. Re-run and re-record, or say in the write-up exactly what was done by
hand and why.

## Storage layout

```
.science/
  ledger.jsonl              append-only: artifacts, values, database fetches
  provenance/<name>.<key>.json
  environments/<hash>.json  deduplicated environment snapshots
  values.json               quotable values
  cache/<request-hash>.json cached database responses
figures/fig3_volcano.png.prov.json   sidecar copy, travels with the figure
```

Commit `.science/` — it is small, text, and it is the audit trail. Add
`.science/cache/` to `.gitignore` if cached responses get large.

## Reading someone else's project

```bash
provenance.py ls --type artifact          # what was produced, when
provenance.py show figures/fig3.png       # code, inputs, environment, git state
provenance.py check                       # does any of it still hold?
```

If `check` is clean and `git` in the manifests is not dirty, every figure can be regenerated
from the recorded commit.
