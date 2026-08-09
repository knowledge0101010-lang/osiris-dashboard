#!/usr/bin/env python3
"""Background reviewer: fail a write-up before a referee does.

    review.py --manuscript draft.md
    review.py --manuscript draft.md --bib refs.bib --online
    review.py --manuscript draft.md --json

Checks, in order of how often they bite:

  figure-missing / figure-drift / figure-unprovenanced
      a referenced figure that is gone, whose bytes no longer match its manifest,
      or that never had one
  number-untraceable
      a numeric claim in prose that matches no recorded value and no number in any
      results table
  citation-*
      DOIs and PMIDs that are malformed, absent from the bibliography, or (with
      --online) that do not resolve
  artifact-orphan
      a file in the results tree carrying no manifest

Blockers exit non-zero. Stdlib only.
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import provenance  # noqa: E402  (sibling script)

BLOCKER, WARN, NOTE = "blocker", "warn", "note"

FIGURE_SUFFIXES = {".png", ".jpg", ".jpeg", ".pdf", ".svg", ".tif", ".tiff", ".eps", ".webp"}
TABLE_SUFFIXES = {".csv", ".tsv", ".xlsx", ".parquet"}
RESULT_DIRS = ("figures", "figs", "results", "tables", "outputs", "output")
SKIP_DIRS = {".science", ".git", "node_modules", "__pycache__", ".venv", "venv", ".ipynb_checkpoints"}

DOI_RE = re.compile(r"\b10\.\d{4,9}/[-._;()/:A-Za-z0-9]+", re.I)
PMID_RE = re.compile(r"\bPMID:?\s*(\d{5,9})\b", re.I)
PANDOC_CITE_RE = re.compile(r"\[@([^\]]+)\]")
BIB_KEY_RE = re.compile(r"@\w+\s*\{\s*([^,\s]+)\s*,")
MD_IMAGE_RE = re.compile(r"!\[[^\]]*\]\(([^)\s]+)")
MD_LINK_RE = re.compile(r"(?<!!)\[[^\]]*\]\(([^)\s]+)")
LATEX_GRAPHIC_RE = re.compile(r"\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}")
NUMBER_RE = re.compile(r"(?<![\w.])(\d[\d,]*(?:\.\d+)?)(?![\w])")
CROSSREF_RE = re.compile(
    r"\b(?:fig(?:ure)?s?|tables?|panels?|eq(?:uation)?s?|sections?|supplement(?:ary)?)\.?\s*"
    r"[A-Za-z]?\d+",
    re.I,
)
# Numbers small enough to be counts of things the reader can see are not claims.
CLAIM_HINTS = re.compile(r"%|‰|×|x-fold|fold|p\s*[=<]|q\s*[=<]|fdr|ci\b|s\.?d\.?|s\.?e\.?m", re.I)
URL_RE = re.compile(r"https?://\S+")
# A significance threshold is a stated convention, not a measured result.
THRESHOLD_RE = re.compile(
    r"\b(?:p|q|padj|p-?adj|fdr|alpha|α)\s*(?:-?\s*value)?\s*[<≤>≥=]{1,2}\s*[\d.]+(?:e-?\d+)?",
    re.I,
)


class Finding:
    def __init__(self, kind: str, severity: str, message: str, where: str = "", hint: str = ""):
        self.kind = kind
        self.severity = severity
        self.message = message
        self.where = where
        self.hint = hint

    def as_dict(self) -> dict:
        return {
            "kind": self.kind,
            "severity": self.severity,
            "message": self.message,
            "where": self.where,
            "hint": self.hint,
        }


# --------------------------------------------------------------------------- text prep


def strip_code(text: str) -> str:
    """Remove fenced blocks, indented blocks, and inline code from prose."""
    text = re.sub(r"```.*?```", "\n", text, flags=re.S)
    text = re.sub(r"~~~.*?~~~", "\n", text, flags=re.S)
    text = re.sub(r"`[^`\n]*`", " ", text)
    text = re.sub(r"^\s{4,}\S.*$", "", text, flags=re.M)
    return text


def line_of(text: str, index: int) -> int:
    return text.count("\n", 0, index) + 1


# --------------------------------------------------------------------------- figures


def referenced_paths(text: str) -> list[tuple[str, int]]:
    found: list[tuple[str, int]] = []
    for pattern in (MD_IMAGE_RE, MD_LINK_RE, LATEX_GRAPHIC_RE):
        for match in pattern.finditer(text):
            target = match.group(1).strip()
            if target.startswith(("http://", "https://", "#", "mailto:")):
                continue
            found.append((target, line_of(text, match.start())))
    # Bare mentions like "figures/fig2_umap.png" in prose.
    bare = re.compile(r"(?<![\w/])((?:%s)/[\w./-]+)" % "|".join(RESULT_DIRS))
    for match in bare.finditer(text):
        found.append((match.group(1), line_of(text, match.start())))
    unique: dict[str, int] = {}
    for path, line in found:
        unique.setdefault(path, line)
    return sorted(unique.items(), key=lambda item: item[1])


def check_figures(root: Path, manuscript: Path, text: str) -> list[Finding]:
    findings: list[Finding] = []
    for raw, line in referenced_paths(text):
        candidate = (manuscript.parent / raw) if not Path(raw).is_absolute() else Path(raw)
        if not candidate.exists():
            alt = root / raw
            candidate = alt if alt.exists() else candidate
        suffix = candidate.suffix.lower()
        if suffix and suffix not in FIGURE_SUFFIXES | TABLE_SUFFIXES:
            continue
        where = f"{manuscript.name}:{line}"
        if not candidate.exists():
            findings.append(
                Finding("figure-missing", BLOCKER, f"referenced file does not exist: {raw}", where)
            )
            continue
        try:
            rel = str(candidate.resolve().relative_to(root))
        except ValueError:
            rel = str(candidate.resolve())
        manifest = provenance.load_manifest(root, rel)
        if manifest is None:
            findings.append(
                Finding(
                    "figure-unprovenanced",
                    BLOCKER,
                    f"{rel} has no provenance manifest",
                    where,
                    f"provenance.py record --artifact {rel} --code <script> --input <data>",
                )
            )
            continue
        fast = manifest["artifact"]["hash"].startswith("sha256-partial")
        current, _ = provenance.hash_path(candidate, fast=fast)
        if current != manifest["artifact"]["hash"]:
            findings.append(
                Finding(
                    "figure-drift",
                    BLOCKER,
                    f"{rel} changed after it was recorded - the manifest describes different bytes",
                    where,
                    "re-run the code and re-record, or explain the manual edit",
                )
            )
            continue
        for dep in manifest.get("inputs", []) + manifest.get("code", []):
            dep_path = root / dep["path"]
            if not dep_path.exists():
                findings.append(
                    Finding("figure-drift", BLOCKER,
                            f"{rel} depends on {dep['path']}, which no longer exists", where)
                )
                continue
            dep_hash, _ = provenance.hash_path(
                dep_path, fast=dep["hash"].startswith("sha256-partial")
            )
            if dep_hash != dep["hash"]:
                findings.append(
                    Finding("figure-drift", BLOCKER,
                            f"{rel} was made from an older version of {dep['path']}", where,
                            "re-run the analysis so the figure matches its inputs")
                )
    return findings


# --------------------------------------------------------------------------- numbers


def collect_data_numbers(root: Path, extra_dirs: list[str] | None, max_bytes: int) -> set[float]:
    numbers: set[float] = set()
    roots = [root / d for d in (extra_dirs or list(RESULT_DIRS))]
    for base in roots:
        if not base.is_dir():
            continue
        for path in base.rglob("*"):
            if not path.is_file() or any(part in SKIP_DIRS for part in path.parts):
                continue
            if path.suffix.lower() not in {".csv", ".tsv", ".json"}:
                continue
            try:
                if path.stat().st_size > max_bytes:
                    continue
                text = path.read_text(errors="replace")
            except OSError:
                continue
            if path.suffix.lower() == ".json":
                _numbers_from_json(text, numbers)
            else:
                delimiter = "\t" if path.suffix.lower() == ".tsv" else ","
                for row in csv.reader(text.splitlines(), delimiter=delimiter):
                    for cell in row:
                        try:
                            numbers.add(float(cell.replace(",", "")))
                        except ValueError:
                            continue
            if len(numbers) > 500_000:
                return numbers
    return numbers


def _numbers_from_json(text: str, sink: set[float]) -> None:
    try:
        payload = json.loads(text)
    except ValueError:
        return

    def walk(node):
        if isinstance(node, dict):
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for value in node:
                walk(value)
        elif isinstance(node, (int, float)) and not isinstance(node, bool):
            sink.add(float(node))
        elif isinstance(node, str):
            try:
                sink.add(float(node.replace(",", "")))
            except ValueError:
                pass

    walk(payload)


def recorded_values(root: Path) -> set[float]:
    store = provenance.science_dir(root) / "values.json"
    numbers: set[float] = set()
    if store.exists():
        try:
            for meta in json.loads(store.read_text()).values():
                value = meta.get("value")
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    numbers.add(float(value))
                elif isinstance(value, str):
                    try:
                        numbers.add(float(value.replace(",", "")))
                    except ValueError:
                        continue
        except ValueError:
            pass
    return numbers


def traceable(claim: str, pool: set[float]) -> bool:
    """A claim is traceable if some recorded number rounds to it at its own precision."""
    plain = claim.replace(",", "")
    try:
        target = float(plain)
    except ValueError:
        return True
    decimals = len(plain.split(".")[1]) if "." in plain else 0
    for value in pool:
        if round(value, decimals) == round(target, decimals):
            return True
        # Percentages written as 12.5 for a stored 0.125.
        if decimals and round(value * 100, decimals) == round(target, decimals):
            return True
    return False


def check_numbers(manuscript: Path, text: str, pool: set[float], min_digits: int) -> list[Finding]:
    findings: list[Finding] = []
    blank = lambda m: " " * len(m.group(0))  # noqa: E731 - keeps offsets, so line numbers hold
    masked = text
    for pattern in (URL_RE, DOI_RE, PMID_RE, CROSSREF_RE, THRESHOLD_RE):
        masked = pattern.sub(blank, masked)
    seen: set[str] = set()
    for match in NUMBER_RE.finditer(masked):
        raw = match.group(1)
        plain = raw.replace(",", "")
        try:
            value = float(plain)
        except ValueError:
            continue
        line_start = masked.rfind("\n", 0, match.start()) + 1
        line_end = masked.find("\n", match.end())
        context = masked[line_start : line_end if line_end != -1 else len(masked)]
        tail = masked[match.end() : match.end() + 12]

        is_year = plain.isdigit() and 1500 <= value <= 2200 and len(plain) == 4
        interesting = (
            "." in plain
            or len(plain.replace(".", "")) >= min_digits
            or CLAIM_HINTS.search(tail)
            or CLAIM_HINTS.search(context)
        )
        if is_year or not interesting:
            continue
        if raw in seen:
            continue
        seen.add(raw)
        if traceable(raw, pool):
            continue
        findings.append(
            Finding(
                "number-untraceable",
                WARN,
                f"'{raw}' is not among the recorded values or any results table",
                f"{manuscript.name}:{line_of(text, match.start())}",
                f"provenance.py value --key <name> --value {plain} --code <script>",
            )
        )
    return findings


# --------------------------------------------------------------------------- citations


def bib_keys(bib: Path | None) -> set[str]:
    if bib is None or not bib.exists():
        return set()
    return set(BIB_KEY_RE.findall(bib.read_text(errors="replace")))


def resolve_doi(doi: str) -> bool:
    url = "https://api.crossref.org/works/" + urllib.parse.quote(doi, safe="/")
    request = urllib.request.Request(url, headers={"User-Agent": "claude-science-review/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            return response.status == 200
    except (urllib.error.URLError, OSError):
        return False


def resolve_pmid(pmid: str) -> bool:
    url = (
        "https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?"
        f"db=pubmed&id={urllib.parse.quote(pmid)}&retmode=json&tool=claude-science"
    )
    request = urllib.request.Request(url, headers={"User-Agent": "claude-science-review/1.0"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:  # noqa: S310
            payload = json.loads(response.read().decode())
    except (urllib.error.URLError, OSError, ValueError):
        return False
    record = payload.get("result", {}).get(pmid, {})
    return bool(record) and "error" not in record


def check_citations(manuscript: Path, text: str, bib: Path | None, online: bool) -> list[Finding]:
    findings: list[Finding] = []
    keys = bib_keys(bib)
    for match in PANDOC_CITE_RE.finditer(text):
        for key in re.split(r"[;,]\s*", match.group(1)):
            key = key.strip().lstrip("@")
            if not key:
                continue
            where = f"{manuscript.name}:{line_of(text, match.start())}"
            if bib is None:
                findings.append(
                    Finding("citation-missing-bib", NOTE,
                            f"citation [@{key}] cannot be checked without --bib", where)
                )
            elif key not in keys:
                findings.append(
                    Finding("citation-missing-bib", BLOCKER,
                            f"citation key '{key}' is not in {bib.name}", where)
                )

    for match in DOI_RE.finditer(text):
        doi = match.group(0).rstrip(".,;)]}")
        where = f"{manuscript.name}:{line_of(text, match.start())}"
        if len(doi.split("/", 1)[-1]) < 2:
            findings.append(Finding("citation-malformed", BLOCKER, f"malformed DOI: {doi}", where))
            continue
        if online and not resolve_doi(doi):
            findings.append(
                Finding("citation-unresolved", BLOCKER, f"DOI does not resolve: {doi}", where,
                        "check the reference actually exists and says what you claim")
            )

    for match in PMID_RE.finditer(text):
        pmid = match.group(1)
        where = f"{manuscript.name}:{line_of(text, match.start())}"
        if online and not resolve_pmid(pmid):
            findings.append(
                Finding("citation-unresolved", BLOCKER, f"PMID does not resolve: {pmid}", where)
            )
    return findings


# --------------------------------------------------------------------------- orphans


def check_orphans(root: Path, dirs: list[str] | None) -> list[Finding]:
    findings: list[Finding] = []
    for name in dirs or list(RESULT_DIRS):
        base = root / name
        if not base.is_dir():
            continue
        for path in sorted(base.rglob("*")):
            if not path.is_file() or path.name.endswith(".prov.json"):
                continue
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            if path.suffix.lower() not in FIGURE_SUFFIXES | TABLE_SUFFIXES:
                continue
            rel = str(path.resolve().relative_to(root))
            if provenance.load_manifest(root, rel) is None:
                findings.append(
                    Finding("artifact-orphan", WARN, f"{rel} exists with no manifest", rel,
                            f"provenance.py record --artifact {rel} --code <script>")
                )
    return findings


# --------------------------------------------------------------------------- report


def report(findings: list[Finding], manuscript: Path, as_json: bool) -> int:
    if as_json:
        print(json.dumps([f.as_dict() for f in findings], indent=2))
    else:
        order = {BLOCKER: 0, WARN: 1, NOTE: 2}
        print(f"# Review of {manuscript}\n")
        if not findings:
            print("No findings. Every referenced figure is provenanced and current, every")
            print("numeric claim traces to a recorded value, and citations are well formed.")
        for finding in sorted(findings, key=lambda f: (order[f.severity], f.kind, f.where)):
            label = {BLOCKER: "BLOCKER", WARN: "WARN   ", NOTE: "NOTE   "}[finding.severity]
            print(f"{label} [{finding.kind}] {finding.where}")
            print(f"        {finding.message}")
            if finding.hint:
                print(f"        -> {finding.hint}")
        counts = {level: sum(1 for f in findings if f.severity == level) for level in
                  (BLOCKER, WARN, NOTE)}
        print(
            f"\n{counts[BLOCKER]} blocker(s), {counts[WARN]} warning(s), {counts[NOTE]} note(s)"
        )
    return 1 if any(f.severity == BLOCKER for f in findings) else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--manuscript", required=True, help="Markdown or LaTeX draft to review")
    parser.add_argument("--project", help="project root (default: cwd)")
    parser.add_argument("--bib", help="BibTeX file backing [@key] citations")
    parser.add_argument("--online", action="store_true", help="resolve DOIs and PMIDs")
    parser.add_argument("--data-dir", action="append",
                        help="directory of result tables to accept numbers from (repeatable)")
    parser.add_argument("--min-digits", type=int, default=3,
                        help="integers shorter than this are not treated as claims (default 3)")
    parser.add_argument("--max-data-bytes", type=int, default=20 << 20)
    parser.add_argument("--skip", action="append",
                        choices=["figures", "numbers", "citations", "orphans"],
                        help="skip a check (repeatable)")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args()

    root = Path(args.project or Path.cwd()).resolve()
    manuscript = Path(args.manuscript)
    if not manuscript.exists():
        print(f"no such manuscript: {manuscript}", file=sys.stderr)
        return 2
    raw = manuscript.read_text(errors="replace")
    prose = strip_code(raw)
    skip = set(args.skip or [])

    findings: list[Finding] = []
    if "figures" not in skip:
        findings += check_figures(root, manuscript, raw)
    if "numbers" not in skip:
        pool = recorded_values(root) | collect_data_numbers(
            root, args.data_dir, args.max_data_bytes
        )
        findings += check_numbers(manuscript, prose, pool, args.min_digits)
    if "citations" not in skip:
        findings += check_citations(manuscript, prose, Path(args.bib) if args.bib else None,
                                    args.online)
    if "orphans" not in skip:
        findings += check_orphans(root, args.data_dir)

    return report(findings, manuscript, args.json)


if __name__ == "__main__":
    sys.exit(main())
