#!/usr/bin/env python3
"""Persistent Python/R kernels for long-running analysis sessions.

A kernel is a daemonised process holding a live namespace. Code sent to it with
`exec` runs in that namespace, so imported modules, loaded matrices, and fitted
models survive between calls. Stdlib only.

    kernel.py start --name main --lang python
    kernel.py exec  --name main --code 'x = 1 + 1; x'
    kernel.py exec  --name main -f steps/01_load.py
    kernel.py interrupt --name main
    kernel.py list | status | stop
"""

from __future__ import annotations

import argparse
import ast
import contextlib
import hashlib
import io
import json
import os
import signal
import socket
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path

MAX_OUTPUT = 200_000
R_SENTINEL = "<<<SCIENCE_KERNEL_DONE>>>"
R_ERRMARK = "<<<SCIENCE_KERNEL_ERROR>>>"


# --------------------------------------------------------------------------- paths


def project_root(explicit: str | None) -> Path:
    return Path(explicit).resolve() if explicit else Path.cwd().resolve()


def kernel_dir(root: Path, name: str) -> Path:
    return root / ".science" / "kernels" / name


def socket_path(kdir: Path) -> str:
    """AF_UNIX paths are capped near 108 bytes; fall back to a hashed /tmp path."""
    candidate = str(kdir / "sock")
    if len(candidate.encode()) < 100:
        return candidate
    digest = hashlib.sha256(candidate.encode()).hexdigest()[:16]
    return str(Path(tempfile.gettempdir()) / f"science-kernel-{digest}.sock")


def read_meta(kdir: Path) -> dict | None:
    try:
        return json.loads((kdir / "meta.json").read_text())
    except (OSError, ValueError):
        return None


# --------------------------------------------------------------------------- client


def request(sock_path: str, payload: dict, timeout: float) -> dict:
    client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    client.settimeout(timeout)
    try:
        client.connect(sock_path)
        client.sendall((json.dumps(payload) + "\n").encode())
        chunks = []
        while True:
            chunk = client.recv(65536)
            if not chunk:
                break
            chunks.append(chunk)
            if chunks[-1].endswith(b"\n"):
                break
        raw = b"".join(chunks).decode(errors="replace").strip()
        if not raw:
            raise ConnectionError("kernel closed the connection without replying")
        return json.loads(raw)
    finally:
        client.close()


def is_alive(kdir: Path) -> tuple[bool, dict | None]:
    meta = read_meta(kdir)
    if not meta:
        return False, None
    try:
        os.kill(meta["pid"], 0)
    except OSError:
        return False, meta
    try:
        reply = request(meta["sock"], {"cmd": "ping"}, timeout=5)
        return bool(reply.get("ok")), meta
    except (OSError, ValueError, ConnectionError):
        return False, meta


# --------------------------------------------------------------------------- executors


class PythonExecutor:
    lang = "python"

    def __init__(self) -> None:
        self.ns: dict = {"__name__": "__main__", "__builtins__": __builtins__}

    def run(self, code: str) -> dict:
        out, err = io.StringIO(), io.StringIO()
        result = None
        error = None
        try:
            tree = ast.parse(code, filename="<kernel>", mode="exec")
        except SyntaxError:
            return {
                "ok": False,
                "stdout": "",
                "stderr": "",
                "result": None,
                "error": traceback.format_exc(limit=0).strip(),
            }

        tail = None
        if tree.body and isinstance(tree.body[-1], ast.Expr):
            tail = ast.Expression(tree.body.pop().value)

        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                if tree.body:
                    exec(compile(tree, "<kernel>", "exec"), self.ns)  # noqa: S102
                if tail is not None:
                    value = eval(compile(tail, "<kernel>", "eval"), self.ns)  # noqa: S307
                    if value is not None:
                        self.ns["_"] = value
                        result = repr(value)
        except KeyboardInterrupt:
            error = "KeyboardInterrupt: execution interrupted"
        except SystemExit as exc:
            error = f"SystemExit: {exc.code}"
        except BaseException:  # noqa: BLE001 - surface anything user code raises
            exc_type, exc_value, tb = sys.exc_info()
            # Hide the kernel's own frames so the traceback reads like a REPL's.
            while tb is not None and tb.tb_frame.f_code.co_filename == __file__:
                tb = tb.tb_next
            error = "".join(traceback.format_exception(exc_type, exc_value, tb))

        return {
            "ok": error is None,
            "stdout": out.getvalue(),
            "stderr": err.getvalue(),
            "result": result,
            "error": error,
        }

    def shutdown(self) -> None:
        pass

    @property
    def child_pid(self) -> int | None:
        return None


class RExecutor:
    """Drives a long-lived `R --slave` process reading from a pipe.

    Submitted code is written to a temp file and `source()`d inside tryCatch so a
    top-level error does not take the process down. Globals persist because the
    source happens in the global environment.
    """

    lang = "r"

    def __init__(self) -> None:
        binary = os.environ.get("SCIENCE_R_BIN", "R")
        self.proc = subprocess.Popen(  # noqa: S603
            [binary, "--vanilla", "--quiet", "--slave", "--no-echo"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            bufsize=1,
        )
        self.tmpdir = tempfile.mkdtemp(prefix="science-r-")
        self.counter = 0

    def run(self, code: str) -> dict:
        if self.proc.poll() is not None:
            return {
                "ok": False,
                "stdout": "",
                "stderr": "",
                "result": None,
                "error": f"R process exited with code {self.proc.returncode}",
            }
        self.counter += 1
        chunk_file = Path(self.tmpdir) / f"chunk_{self.counter}.R"
        chunk_file.write_text(code if code.endswith("\n") else code + "\n")
        driver = (
            "tryCatch(source(%r, echo=FALSE, print.eval=TRUE, local=FALSE), "
            'error=function(e) cat("%s", conditionMessage(e), "\\n"))\n'
            'cat("\\n%s\\n")\n'
        ) % (str(chunk_file), R_ERRMARK, R_SENTINEL)

        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(driver)
        self.proc.stdin.flush()

        lines: list[str] = []
        error = None
        while True:
            line = self.proc.stdout.readline()
            if not line:
                error = "R process closed its output stream"
                break
            if line.strip() == R_SENTINEL:
                break
            if line.startswith(R_ERRMARK):
                error = "R error: " + line[len(R_ERRMARK) :].strip()
                continue
            lines.append(line)

        return {
            "ok": error is None,
            "stdout": "".join(lines),
            "stderr": "",
            "result": None,
            "error": error,
        }

    def shutdown(self) -> None:
        with contextlib.suppress(Exception):
            assert self.proc.stdin is not None
            self.proc.stdin.write("q(save='no')\n")
            self.proc.stdin.flush()
            self.proc.wait(timeout=5)
        with contextlib.suppress(Exception):
            self.proc.kill()

    @property
    def child_pid(self) -> int | None:
        return self.proc.pid


# --------------------------------------------------------------------------- server


class Server:
    def __init__(self, executor, sock_path: str) -> None:
        self.executor = executor
        self.sock_path = sock_path
        self.executing = False
        signal.signal(signal.SIGINT, self._on_sigint)

    def _on_sigint(self, _signum, _frame) -> None:
        # Only user code should see the interrupt; an idle kernel ignores it.
        if self.executing:
            raise KeyboardInterrupt

    def serve(self, listener: socket.socket) -> None:
        while True:
            try:
                conn, _ = listener.accept()
            except InterruptedError:
                continue
            except OSError:
                break
            try:
                conn.settimeout(None)
                buf = b""
                while not buf.endswith(b"\n"):
                    chunk = conn.recv(65536)
                    if not chunk:
                        break
                    buf += chunk
                if not buf.strip():
                    continue
                req = json.loads(buf.decode())
                reply = self.handle(req)
                conn.sendall((json.dumps(reply) + "\n").encode())
                if req.get("cmd") == "shutdown":
                    conn.close()
                    break
            except Exception:  # noqa: BLE001 - a bad request must not kill the kernel
                with contextlib.suppress(Exception):
                    conn.sendall(
                        (json.dumps({"ok": False, "error": traceback.format_exc()}) + "\n").encode()
                    )
            finally:
                with contextlib.suppress(Exception):
                    conn.close()

        self.executor.shutdown()
        with contextlib.suppress(OSError):
            os.unlink(self.sock_path)

    def handle(self, req: dict) -> dict:
        cmd = req.get("cmd", "exec")
        if cmd == "ping":
            return {"ok": True, "lang": self.executor.lang, "pid": os.getpid()}
        if cmd == "shutdown":
            return {"ok": True}
        if cmd == "exec":
            started = time.time()
            self.executing = True
            try:
                result = self.executor.run(req.get("code", ""))
            finally:
                self.executing = False
            result["duration"] = round(time.time() - started, 4)
            for key in ("stdout", "stderr"):
                text = result.get(key) or ""
                if len(text) > MAX_OUTPUT:
                    result[key] = (
                        text[:MAX_OUTPUT] + f"\n... [truncated {len(text) - MAX_OUTPUT} chars]"
                    )
            return result
        return {"ok": False, "error": f"unknown command: {cmd}"}


def daemonise(log_path: Path) -> None:
    if os.fork() > 0:
        os._exit(0)
    os.setsid()
    if os.fork() > 0:
        os._exit(0)
    log = os.open(str(log_path), os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o644)
    devnull = os.open(os.devnull, os.O_RDONLY)
    os.dup2(devnull, 0)
    os.dup2(log, 1)
    os.dup2(log, 2)


def start_kernel(args) -> int:
    root = project_root(args.project)
    kdir = kernel_dir(root, args.name)
    alive, _ = is_alive(kdir)
    if alive:
        if not args.restart:
            print(f"kernel '{args.name}' is already running (use --restart to replace it)")
            return 0
        stop_kernel(args)

    kdir.mkdir(parents=True, exist_ok=True)
    sock_path = socket_path(kdir)
    with contextlib.suppress(OSError):
        os.unlink(sock_path)

    read_fd, write_fd = os.pipe()
    if os.fork() == 0:
        os.close(read_fd)
        try:
            daemonise(kdir / "kernel.log")
            os.chdir(str(root))
            listener = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            listener.bind(sock_path)
            listener.listen(8)
            executor = PythonExecutor() if args.lang == "python" else RExecutor()
            meta = {
                "name": args.name,
                "lang": args.lang,
                "pid": os.getpid(),
                "child_pid": executor.child_pid,
                "sock": sock_path,
                "cwd": str(root),
                "started": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            (kdir / "meta.json").write_text(json.dumps(meta, indent=2))
            os.write(write_fd, b"ready\n")
            os.close(write_fd)
            Server(executor, sock_path).serve(listener)
        except BaseException as exc:  # noqa: BLE001
            with contextlib.suppress(OSError):
                os.write(write_fd, f"error: {exc}\n".encode())
                os.close(write_fd)
            traceback.print_exc()
        os._exit(0)

    os.close(write_fd)
    os.waitpid(-1, 0)  # reap the intermediate fork
    with os.fdopen(read_fd) as pipe:
        status = pipe.readline().strip()
    if status != "ready":
        print(f"failed to start kernel '{args.name}': {status or 'no response'}", file=sys.stderr)
        print(f"see {kdir / 'kernel.log'}", file=sys.stderr)
        return 1
    print(f"kernel '{args.name}' ({args.lang}) started in {root}")
    return 0


# --------------------------------------------------------------------------- commands


def load_code(args) -> str:
    if args.code is not None:
        return args.code
    if args.file == "-":
        return sys.stdin.read()
    if args.file:
        return Path(args.file).read_text()
    raise SystemExit("provide --code, -f FILE, or -f -")


def exec_code(args) -> int:
    root = project_root(args.project)
    kdir = kernel_dir(root, args.name)
    alive, meta = is_alive(kdir)
    if not alive:
        print(
            f"kernel '{args.name}' is not running - start it with:\n"
            f"  kernel.py start --name {args.name}",
            file=sys.stderr,
        )
        return 2
    assert meta is not None
    code = load_code(args)
    try:
        reply = request(meta["sock"], {"cmd": "exec", "code": code}, timeout=args.timeout)
    except socket.timeout:
        print(
            f"timed out after {args.timeout}s; the kernel is still running.\n"
            f"  kernel.py interrupt --name {args.name}   # to stop the cell",
            file=sys.stderr,
        )
        return 3

    if args.json:
        print(json.dumps(reply, indent=2))
        return 0 if reply.get("ok") else 1

    if reply.get("stdout"):
        sys.stdout.write(reply["stdout"])
        if not reply["stdout"].endswith("\n"):
            sys.stdout.write("\n")
    if reply.get("stderr"):
        sys.stderr.write(reply["stderr"])
    if reply.get("result") is not None:
        print(reply["result"])
    if not reply.get("ok"):
        sys.stderr.write((reply.get("error") or "unknown error").rstrip() + "\n")
        return 1
    if args.timing:
        print(f"[{reply.get('duration')}s]", file=sys.stderr)
    return 0


def interrupt_kernel(args) -> int:
    root = project_root(args.project)
    kdir = kernel_dir(root, args.name)
    meta = read_meta(kdir)
    if not meta:
        print(f"no kernel '{args.name}'", file=sys.stderr)
        return 2
    target = meta.get("child_pid") or meta["pid"]
    try:
        os.kill(target, signal.SIGINT)
    except OSError as exc:
        print(f"could not interrupt: {exc}", file=sys.stderr)
        return 1
    print(f"sent SIGINT to kernel '{args.name}' (pid {target})")
    return 0


def stop_kernel(args) -> int:
    root = project_root(args.project)
    names = [args.name]
    if getattr(args, "all", False):
        base = root / ".science" / "kernels"
        names = sorted(p.name for p in base.iterdir()) if base.is_dir() else []
    code = 0
    for name in names:
        kdir = kernel_dir(root, name)
        meta = read_meta(kdir)
        if not meta:
            continue
        with contextlib.suppress(Exception):
            request(meta["sock"], {"cmd": "shutdown"}, timeout=5)
        deadline = time.time() + 5
        while time.time() < deadline:
            try:
                os.kill(meta["pid"], 0)
            except OSError:
                break
            time.sleep(0.1)
        else:
            with contextlib.suppress(OSError):
                os.kill(meta["pid"], signal.SIGKILL)
        with contextlib.suppress(OSError):
            os.unlink(meta["sock"])
        with contextlib.suppress(OSError):
            (kdir / "meta.json").unlink()
        print(f"stopped kernel '{name}'")
    return code


def list_kernels(args) -> int:
    root = project_root(args.project)
    base = root / ".science" / "kernels"
    if not base.is_dir():
        print("no kernels in this project")
        return 0
    rows = []
    for kdir in sorted(base.iterdir()):
        if not kdir.is_dir():
            continue
        alive, meta = is_alive(kdir)
        if meta is None:
            continue
        rows.append((kdir.name, meta.get("lang", "?"), "running" if alive else "dead",
                     str(meta.get("pid", "-")), meta.get("started", "-")))
    if not rows:
        print("no kernels in this project")
        return 0
    width = max(len(r[0]) for r in rows)
    for name, lang, state, pid, started in rows:
        print(f"{name.ljust(width)}  {lang:<7} {state:<8} pid={pid:<8} started={started}")
    return 0


def status_kernel(args) -> int:
    root = project_root(args.project)
    kdir = kernel_dir(root, args.name)
    alive, meta = is_alive(kdir)
    if meta is None:
        print(f"no kernel '{args.name}'", file=sys.stderr)
        return 2
    print(json.dumps({**meta, "running": alive}, indent=2))
    return 0 if alive else 1


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--project", help="project root (default: cwd)")
    sub = parser.add_subparsers(dest="command", required=True)

    start = sub.add_parser("start", help="start a kernel")
    start.add_argument("--name", default="main")
    start.add_argument("--lang", choices=["python", "r"], default="python")
    start.add_argument("--restart", action="store_true", help="replace a running kernel")
    start.set_defaults(func=start_kernel)

    run = sub.add_parser("exec", help="run code in a kernel")
    run.add_argument("--name", default="main")
    run.add_argument("--code")
    run.add_argument("-f", "--file", help="file to run, or - for stdin")
    run.add_argument("--timeout", type=float, default=3600.0)
    run.add_argument("--json", action="store_true", help="emit the raw reply")
    run.add_argument("--timing", action="store_true", help="print elapsed time to stderr")
    run.set_defaults(func=exec_code)

    interrupt = sub.add_parser("interrupt", help="SIGINT the running cell")
    interrupt.add_argument("--name", default="main")
    interrupt.set_defaults(func=interrupt_kernel)

    stop = sub.add_parser("stop", help="stop a kernel")
    stop.add_argument("--name", default="main")
    stop.add_argument("--all", action="store_true")
    stop.set_defaults(func=stop_kernel)

    listing = sub.add_parser("list", help="list kernels")
    listing.set_defaults(func=list_kernels)

    status = sub.add_parser("status", help="show kernel metadata")
    status.add_argument("--name", default="main")
    status.set_defaults(func=status_kernel)

    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
