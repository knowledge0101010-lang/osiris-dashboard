#!/usr/bin/env python3
"""Provenance for scientific artifacts: bind every result to what produced it.

    provenance.py record --artifact figures/fig2.png --code steps/02.py \
        --input data/counts.h5ad --title "UMAP by cluster"
    provenance.py value  --key de_genes_fdr05 --value 1284 --code steps/03.py
    provenance.py check                       # re-hash everything, report drift
    provenance.py show figures/fig2.png
    provenance.py ls

Manifests are written twice: as a sidecar `<artifact>.prov.json` next to the file
and into `.science/provenance/`, with an append-only `.science/ledger.jsonl`.
Environment snapshots are content-addressed in `.science/environments/` so a
hundred figures from one session share a single copy. Stdlib only.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import socket
import subprocess
import sys
import time
from pathlib import Path

SCHEMA = "science.provenance/1"
TOOL = "claude-science/provenance.py 1.0"
CHUNK = 1 << 20
FAST_HASH_EDGE = 8 << 20
SNIPPET_CHARS = 4000


def now() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


def science_dir(root: Path) -> Path:
    return root / ".science"


# --------------------------------------------------------------------------- hashing


def hash_file(path: Path, fast: bool = False) -> tuple[str, int]:
    size = path.stat().st_size
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        if fast and size > 2 * FAST_HASH_EDGE:
            digest.update(str(size).encode())
            digest.update(handle.read(FAST_HASH_EDGE))
            handle.seek(-FAST_HASH_EDGE, os.SEEK_END)
            digest.update(handle.read(FAST_HASH_EDGE))
            return "sha256-partial:" + digest.hexdigest(), size
        while chunk := handle.read(CHUNK):
            digest.update(chunk)
    return "sha256:" + digest.hexdigest(), size


def hash_dir(path: Path, fast: bool = False) -> tuple[str, int]:
    """Hash a directory as the sorted list of (relative path, file hash)."""
    digest = hashlib.sha256()
    total = 0
    for child in sorted(p for p in path.rglob("*") if p.is_file()):
        file_hash, size = hash_file(child, fast=fast)
        total += size
        digest.update(str(child.relative_to(path)).encode())
        digest.update(file_hash.encode())
    return "sha256-tree:" + digest.hexdigest(), total


def hash_path(path: Path, fast: bool = False) -> tuple[str, int]:
    if path.is_dir():
        return hash_dir(path, fast=fast)
    return hash_file(path, fast=fast)


def describe_path(root: Path, raw: str, fast: bool = False, snippet: bool = False) -> dict:
    path = Path(raw)
    resolved = path if path.is_absolute() else (root / path)
    if not resolved.exists():
        raise SystemExit(f"error: no such path: {raw}")
    digest, size = hash_path(resolved, fast=fast)
    try:
        rel = str(resolved.resolve().relative_to(root))
    except ValueError:
        rel = str(resolved.resolve())
    entry = {
        "path": rel,
        "hash": digest,
        "bytes": size,
        "modified": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(resolved.stat().st_mtime)),
    }
    if snippet and resolved.is_file():
        try:
            text = resolved.read_text()
            entry["lines"] = text.count("\n") + 1
            entry["snippet"] = text[:SNIPPET_CHARS]
            entry["snippet_truncated"] = len(text) > SNIPPET_CHARS
        except (UnicodeDecodeError, OSError):
            pass
    return entry


# --------------------------------------------------------------------------- environment


def git_info(root: Path) -> dict:
    def run(*args: str) -> str | None:
        try:
            out = subprocess.run(  # noqa: S603
                ["git", *args], cwd=str(root), capture_output=True, text=True, timeout=15
            )
        except (OSError, subprocess.SubprocessError):
            return None
        return out.stdout.strip() if out.returncode == 0 else None

    commit = run("rev-parse", "HEAD")
    if commit is None:
        return {"tracked": False}
    status = run("status", "--porcelain") or ""
    return {
        "tracked": True,
        "commit": commit,
        "branch": run("rev-parse", "--abbrev-ref", "HEAD"),
        "remote": run("config", "--get", "remote.origin.url"),
        "dirty": bool(status.strip()),
        "dirty_files": [line[3:] for line in status.splitlines()[:50]] if status.strip() else [],
    }


def package_list() -> list[str]:
    try:
        from importlib import metadata
    except ImportError:  # pragma: no cover - Python < 3.8
        return []
    seen = {}
    for dist in metadata.distributions():
        name = (dist.metadata["Name"] or "").strip()
        if name:
            seen[name.lower()] = f"{name}=={dist.version}"
    return sorted(seen.values())


def r_version() -> str | None:
    binary = os.environ.get("SCIENCE_R_BIN", "R")
    try:
        out = subprocess.run(  # noqa: S603
            [binary, "--version"], capture_output=True, text=True, timeout=15
        )
    except (OSError, subprocess.SubprocessError):
        return None
    if out.returncode != 0:
        return None
    return (out.stdout or out.stderr).splitlines()[0].strip()


def environment_snapshot(root: Path, with_r: bool = False) -> str:
    """Write a content-addressed environment snapshot; return its reference."""
    env = {
        "python": sys.version.split()[0],
        "python_executable": sys.executable,
        "implementation": platform.python_implementation(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "hostname": socket.gethostname(),
        "user": os.environ.get("USER") or os.environ.get("USERNAME"),
        "cpu_count": os.cpu_count(),
        "conda_env": os.environ.get("CONDA_DEFAULT_ENV"),
        "virtualenv": os.environ.get("VIRTUAL_ENV"),
        "packages": package_list(),
    }
    if with_r:
        env["r"] = r_version()
    payload = json.dumps(env, sort_keys=True, indent=2)
    ref = "sha256:" + hashlib.sha256(payload.encode()).hexdigest()
    target = science_dir(root) / "environments" / f"{ref.split(':')[1][:16]}.json"
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists():
        target.write_text(payload)
    return ref


# --------------------------------------------------------------------------- ledger


def append_ledger(root: Path, entry: dict) -> None:
    ledger = science_dir(root) / "ledger.jsonl"
    ledger.parent.mkdir(parents=True, exist_ok=True)
    with ledger.open("a") as handle:
        handle.write(json.dumps(entry, sort_keys=True) + "\n")


def read_ledger(root: Path) -> list[dict]:
    ledger = science_dir(root) / "ledger.jsonl"
    if not ledger.exists():
        return []
    entries = []
    for line in ledger.read_text().splitlines():
        if line.strip():
            try:
                entries.append(json.loads(line))
            except ValueError:
                continue
    return entries


def manifest_store(root: Path, artifact_rel: str) -> Path:
    key = hashlib.sha256(artifact_rel.encode()).hexdigest()[:20]
    stem = Path(artifact_rel).name.replace(os.sep, "_")
    return science_dir(root) / "provenance" / f"{stem}.{key}.json"


def load_manifest(root: Path, artifact: str) -> dict | None:
    path = Path(artifact)
    resolved = path if path.is_absolute() else root / path
    sidecar = resolved.with_name(resolved.name + ".prov.json")
    if sidecar.exists():
        return json.loads(sidecar.read_text())
    try:
        rel = str(resolved.resolve().relative_to(root))
    except ValueError:
        rel = str(resolved.resolve())
    stored = manifest_store(root, rel)
    if stored.exists():
        return json.loads(stored.read_text())
    return None


# --------------------------------------------------------------------------- commands


def cmd_record(args) -> int:
    root = Path(args.project or Path.cwd()).resolve()
    artifact = describe_path(root, args.artifact, fast=args.fast_hash)
    manifest = {
        "schema": SCHEMA,
        "tool": TOOL,
        "recorded_at": now(),
        "recorded_by": f"{os.environ.get('USER', 'unknown')}@{socket.gethostname()}",
        "title": args.title,
        "note": args.note,
        "kernel": args.kernel,
        "command": args.command,
        "artifact": artifact,
        "code": [describe_path(root, c, snippet=True) for c in (args.code or [])],
        "inputs": [describe_path(root, i, fast=args.fast_hash) for i in (args.input or [])],
        "environment_ref": environment_snapshot(root, with_r=args.with_r),
        "git": git_info(root),
    }
    if not manifest["code"]:
        print(
            "warning: recorded without --code; an artifact with no code is not reproducible",
            file=sys.stderr,
        )
    if manifest["git"].get("dirty"):
        print(
            "warning: git tree is dirty - the recorded commit does not describe this run",
            file=sys.stderr,
        )

    payload = json.dumps(manifest, indent=2, sort_keys=True)
    target = root / artifact["path"]
    sidecar = target.with_name(target.name + ".prov.json")
    sidecar.write_text(payload)
    stored = manifest_store(root, artifact["path"])
    stored.parent.mkdir(parents=True, exist_ok=True)
    stored.write_text(payload)
    append_ledger(
        root,
        {
            "ts": manifest["recorded_at"],
            "type": "artifact",
            "path": artifact["path"],
            "hash": artifact["hash"],
            "title": args.title,
            "manifest": str(stored.relative_to(root)),
        },
    )
    print(f"recorded {artifact['path']}  ({artifact['hash'][:23]}...)")
    print(f"  manifest: {sidecar.relative_to(root) if sidecar.is_relative_to(root) else sidecar}")
    return 0


def cmd_value(args) -> int:
    root = Path(args.project or Path.cwd()).resolve()
    store = science_dir(root) / "values.json"
    store.parent.mkdir(parents=True, exist_ok=True)
    values = json.loads(store.read_text()) if store.exists() else {}

    if args.list:
        if not values:
            print("no recorded values")
            return 0
        width = max(len(k) for k in values)
        for key, meta in sorted(values.items()):
            print(f"{key.ljust(width)}  {meta['value']!r:<20} {meta.get('note') or ''}")
        return 0
    if args.get:
        if args.get not in values:
            print(f"no recorded value '{args.get}'", file=sys.stderr)
            return 1
        print(json.dumps(values[args.get], indent=2))
        return 0
    if not args.key or args.value is None:
        print("provide --key and --value (or --list / --get KEY)", file=sys.stderr)
        return 2

    raw = args.value
    parsed: object = raw
    try:
        parsed = int(raw)
    except ValueError:
        try:
            parsed = float(raw)
        except ValueError:
            pass
    values[args.key] = {
        "value": parsed,
        "raw": raw,
        "unit": args.unit,
        "note": args.note,
        "code": [describe_path(root, c)["path"] for c in (args.code or [])],
        "recorded_at": now(),
    }
    store.write_text(json.dumps(values, indent=2, sort_keys=True))
    append_ledger(root, {"ts": now(), "type": "value", "key": args.key, "value": parsed})
    print(f"recorded value {args.key} = {parsed}" + (f" {args.unit}" if args.unit else ""))
    return 0


def cmd_check(args) -> int:
    root = Path(args.project or Path.cwd()).resolve()
    targets = args.paths or sorted(
        {e["path"] for e in read_ledger(root) if e.get("type") == "artifact"}
    )
    if not targets:
        print("nothing recorded yet")
        return 0

    problems = 0
    for rel in targets:
        manifest = load_manifest(root, rel)
        if manifest is None:
            print(f"NO-MANIFEST  {rel}")
            problems += 1
            continue
        path = root / manifest["artifact"]["path"]
        if not path.exists():
            print(f"MISSING      {rel}")
            problems += 1
            continue
        fast = manifest["artifact"]["hash"].startswith("sha256-partial")
        current, _ = hash_path(path, fast=fast)
        if current != manifest["artifact"]["hash"]:
            print(f"DRIFT        {rel}  (artifact changed since it was recorded)")
            problems += 1
            continue
        input_problem = False
        for dep in manifest.get("inputs", []) + manifest.get("code", []):
            dep_path = root / dep["path"]
            if not dep_path.exists():
                print(f"DEP-MISSING  {rel}  <- {dep['path']}")
                input_problem = True
                continue
            dep_fast = dep["hash"].startswith("sha256-partial")
            dep_hash, _ = hash_path(dep_path, fast=dep_fast)
            if dep_hash != dep["hash"]:
                print(f"DEP-DRIFT    {rel}  <- {dep['path']} changed after the run")
                input_problem = True
        if input_problem:
            problems += 1
        elif not args.quiet:
            print(f"OK           {rel}")

    print(f"\n{len(targets)} artifact(s) checked, {problems} problem(s)")
    return 1 if problems else 0


def cmd_show(args) -> int:
    root = Path(args.project or Path.cwd()).resolve()
    manifest = load_manifest(root, args.artifact)
    if manifest is None:
        print(f"no manifest for {args.artifact}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(manifest, indent=2, sort_keys=True))
        return 0
    art = manifest["artifact"]
    print(f"{art['path']}")
    print(f"  title       : {manifest.get('title') or '-'}")
    print(f"  recorded    : {manifest['recorded_at']} by {manifest.get('recorded_by')}")
    print(f"  hash        : {art['hash']}")
    print(f"  kernel      : {manifest.get('kernel') or '-'}")
    for entry in manifest.get("code", []):
        print(f"  code        : {entry['path']}  ({entry['hash'][:23]}...)")
    for entry in manifest.get("inputs", []):
        print(f"  input       : {entry['path']}  ({entry['hash'][:23]}...)")
    git = manifest.get("git", {})
    if git.get("tracked"):
        print(f"  git         : {git.get('commit', '')[:12]} on {git.get('branch')}"
              + ("  [DIRTY]" if git.get("dirty") else ""))
    env_ref = manifest.get("environment_ref", "")
    if env_ref:
        env_file = science_dir(root) / "environments" / f"{env_ref.split(':')[1][:16]}.json"
        print(f"  environment : {env_file if env_file.exists() else env_ref}")
    if manifest.get("note"):
        print(f"  note        : {manifest['note']}")
    return 0


def cmd_ls(args) -> int:
    root = Path(args.project or Path.cwd()).resolve()
    entries = read_ledger(root)
    if args.type:
        entries = [e for e in entries if e.get("type") == args.type]
    if not entries:
        print("ledger is empty")
        return 0
    for entry in entries[-args.limit :]:
        kind = entry.get("type", "?")
        if kind == "artifact":
            print(f"{entry['ts']}  artifact  {entry['path']}  {entry.get('title') or ''}")
        elif kind == "value":
            print(f"{entry['ts']}  value     {entry['key']} = {entry['value']}")
        elif kind == "fetch":
            print(f"{entry['ts']}  fetch     {entry.get('db')} {entry.get('op')}  {entry.get('url')}")
        else:
            print(f"{entry.get('ts')}  {kind}  {json.dumps(entry)}")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", help="project root (default: cwd)")
    sub = parser.add_subparsers(dest="command", required=True)

    record = sub.add_parser("record", help="record a manifest for an artifact")
    record.add_argument("--artifact", required=True, help="figure, table, model, dataset")
    record.add_argument("--code", action="append", help="script that produced it (repeatable)")
    record.add_argument("--input", action="append", help="input file or directory (repeatable)")
    record.add_argument("--title")
    record.add_argument("--note")
    record.add_argument("--kernel", help="kernel name the artifact came from")
    record.add_argument("--command", help="exact command line, if run outside a kernel")
    record.add_argument("--with-r", action="store_true", help="also capture the R version")
    record.add_argument("--fast-hash", action="store_true", help="edge-hash files over 16 MB")
    record.set_defaults(func=cmd_record)

    value = sub.add_parser("value", help="record or read a quotable value")
    value.add_argument("--key")
    value.add_argument("--value")
    value.add_argument("--unit")
    value.add_argument("--note")
    value.add_argument("--code", action="append")
    value.add_argument("--list", action="store_true")
    value.add_argument("--get")
    value.set_defaults(func=cmd_value)

    check = sub.add_parser("check", help="re-hash artifacts and report drift")
    check.add_argument("paths", nargs="*")
    check.add_argument("--quiet", action="store_true", help="only print problems")
    check.set_defaults(func=cmd_check)

    show = sub.add_parser("show", help="print an artifact's provenance")
    show.add_argument("artifact")
    show.add_argument("--json", action="store_true")
    show.set_defaults(func=cmd_show)

    listing = sub.add_parser("ls", help="print the ledger")
    listing.add_argument("--limit", type=int, default=50)
    listing.add_argument("--type", choices=["artifact", "value", "fetch"])
    listing.set_defaults(func=cmd_ls)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
