#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════
 *  ORCHESTRA — dispatch
 *  Claude Code is the conductor. `codex exec` runs are the players.
 *
 *  One task = one git worktree = one non-interactive Codex session.
 *  Tasks with satisfied dependencies run concurrently up to a pool
 *  limit; each result is verified by a command before it counts as
 *  done, and a failed verification is fed back into one retry.
 *
 *  Harness sections this implements (docs/anthropic-academy):
 *    §12 task system        durable records + dependencies
 *    §13 background exec    a pool of off-loop child processes
 *    §15 worktree isolation one checkout per task, no collisions
 *    §21 loop engineering   verification loop + hard budgets
 * ═══════════════════════════════════════════════════════════════
 */

import { spawn } from 'node:child_process';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';

const execFileAsync = promisify(execFile);

/* ─────────────────────────────────────────────────────────────
   Constants
   ───────────────────────────────────────────────────────────── */

const REPO_ROOT = process.cwd();
const RUN_ROOT = path.join(REPO_ROOT, '.orchestra');
const WORKTREE_ROOT = path.join(RUN_ROOT, 'worktrees');
const RUNS_ROOT = path.join(RUN_ROOT, 'runs');
const STATE_FILE = path.join(RUN_ROOT, 'state.json');
const REPORT_FILE = path.join(RUN_ROOT, 'report.md');

const BRANCH_PREFIX = 'orchestra/';
const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i;

const DEFAULTS = {
  sandbox: 'workspace-write',
  timeoutMs: 30 * 60 * 1000,
  verifyRetries: 1,
  verify: null,
  model: null,
};

/* ─────────────────────────────────────────────────────────────
   CLI
   ───────────────────────────────────────────────────────────── */

function parseArgs(argv) {
  const opts = {
    board: path.join(REPO_ROOT, 'orchestra', 'board.json'),
    concurrency: 3,
    only: null,
    dryRun: false,
    fresh: false,
    keepWorktrees: false,
    baseRef: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined) throw new Error(`${arg} requires a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--board': opts.board = path.resolve(next()); break;
      case '--concurrency': case '-j': opts.concurrency = Number.parseInt(next(), 10); break;
      case '--only': opts.only = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--base': opts.baseRef = next(); break;
      case '--dry-run': opts.dryRun = true; break;
      case '--fresh': opts.fresh = true; break;
      case '--keep-worktrees': opts.keepWorktrees = true; break;
      case '--help': case '-h': printHelp(); process.exit(0); break;
      default: throw new Error(`unknown flag: ${arg}`);
    }
  }
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1) {
    throw new Error('--concurrency must be a positive integer');
  }
  return opts;
}

function printHelp() {
  process.stdout.write(`orchestra/dispatch.mjs — run Codex workers under Claude Code's baton

  node orchestra/dispatch.mjs [options]

  --board <file>       task board (default orchestra/board.json)
  -j, --concurrency N  max Codex sessions in flight (default 3)
  --only a,b           run only these task ids (dependencies still respected)
  --base <ref>         branch each worktree from this ref (default: current HEAD)
  --dry-run            plan and print the exact codex commands, run nothing
  --fresh              ignore .orchestra/state.json and re-run completed tasks
  --keep-worktrees     do not remove clean worktrees when finished
  -h, --help           this text

Results land in .orchestra/ — runs/<id>/events.jsonl, runs/<id>/last.md,
state.json (resumable), and report.md.
`);
}

/* ─────────────────────────────────────────────────────────────
   Board loading and validation
   ───────────────────────────────────────────────────────────── */

async function loadBoard(file) {
  // A board runs its `verify` lines as shell commands, so an unreviewed board
  // is unreviewed code. One from inside the repo went through PR review; one
  // handed over some other way did not.
  if (!file.startsWith(`${REPO_ROOT}${path.sep}`)) {
    process.stderr.write(
      `orchestra: warning — board is outside this repository:\n`
      + `    ${file}\n`
      + `  Its 'verify' lines run as shell commands here. Read it before running,\n`
      + `  or re-run with --dry-run to print what it would execute.\n\n`,
    );
  }

  let raw;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch {
    throw new Error(`cannot read board at ${file}`);
  }
  let board;
  try {
    board = JSON.parse(raw);
  } catch (err) {
    throw new Error(`board is not valid JSON: ${err.message}`);
  }
  if (!Array.isArray(board.tasks)) throw new Error('board.tasks must be an array');

  const defaults = { ...DEFAULTS, ...(board.defaults ?? {}) };
  const seen = new Set();
  const tasks = board.tasks.map((task, index) => {
    if (typeof task.id !== 'string' || !ID_PATTERN.test(task.id)) {
      throw new Error(`task[${index}].id must match ${ID_PATTERN} (got ${JSON.stringify(task.id)})`);
    }
    if (seen.has(task.id)) throw new Error(`duplicate task id: ${task.id}`);
    seen.add(task.id);
    if (typeof task.prompt !== 'string' || task.prompt.trim() === '') {
      throw new Error(`task ${task.id}: prompt must be a non-empty string`);
    }
    const dependsOn = task.dependsOn ?? [];
    if (!Array.isArray(dependsOn)) throw new Error(`task ${task.id}: dependsOn must be an array`);
    return {
      id: task.id,
      title: task.title ?? task.id,
      prompt: task.prompt,
      dependsOn,
      verify: task.verify ?? defaults.verify,
      verifyRetries: task.verifyRetries ?? defaults.verifyRetries,
      sandbox: task.sandbox ?? defaults.sandbox,
      timeoutMs: task.timeoutMs ?? defaults.timeoutMs,
      model: task.model ?? defaults.model,
    };
  });

  for (const task of tasks) {
    for (const dep of task.dependsOn) {
      if (!seen.has(dep)) throw new Error(`task ${task.id} depends on unknown task ${dep}`);
      if (dep === task.id) throw new Error(`task ${task.id} depends on itself`);
    }
  }
  assertAcyclic(tasks);
  return tasks;
}

/** Depth-first cycle detection. A cycle means no task is ever ready. */
function assertAcyclic(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const state = new Map(); // id -> 'open' | 'done'
  const walk = (id, trail) => {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'open') throw new Error(`dependency cycle: ${[...trail, id].join(' -> ')}`);
    state.set(id, 'open');
    for (const dep of byId.get(id).dependsOn) walk(dep, [...trail, id]);
    state.set(id, 'done');
  };
  for (const task of tasks) walk(task.id, []);
}

/** Keep only the requested ids plus everything they transitively depend on. */
function selectTasks(tasks, only) {
  if (!only) return tasks;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  for (const id of only) {
    if (!byId.has(id)) throw new Error(`--only names unknown task: ${id}`);
  }
  const keep = new Set();
  const walk = (id) => {
    if (keep.has(id)) return;
    keep.add(id);
    for (const dep of byId.get(id).dependsOn) walk(dep);
  };
  for (const id of only) walk(id);
  return tasks.filter((t) => keep.has(t.id));
}

/* ─────────────────────────────────────────────────────────────
   State — durable across runs (§12)
   ───────────────────────────────────────────────────────────── */

async function loadState(fresh) {
  if (fresh) return { tasks: {} };
  try {
    return JSON.parse(await fsp.readFile(STATE_FILE, 'utf8'));
  } catch {
    return { tasks: {} };
  }
}

async function saveState(state) {
  await fsp.mkdir(RUN_ROOT, { recursive: true });
  await fsp.writeFile(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`);
}

/* ─────────────────────────────────────────────────────────────
   Git worktrees — one private checkout per task (§15)
   ───────────────────────────────────────────────────────────── */

async function git(args, cwd = REPO_ROOT) {
  const { stdout } = await execFileAsync('git', args, { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

async function resolveBaseRef(explicit) {
  if (explicit) return git(['rev-parse', explicit]);
  return git(['rev-parse', 'HEAD']);
}

async function createWorktree(taskId, baseSha) {
  const dir = path.join(WORKTREE_ROOT, taskId);
  const branch = `${BRANCH_PREFIX}${taskId}`;
  await fsp.mkdir(WORKTREE_ROOT, { recursive: true });

  // A leftover worktree from an interrupted run would silently reuse stale
  // state, so it has to go before a fresh one is created — but only when it
  // holds nothing a human still needs. An interrupted run can leave a worker's
  // uncommitted work here, and the rule everywhere else in this file is that
  // dirty worktrees survive for review. Forcing the removal would break that
  // rule at exactly the moment it matters.
  if (fs.existsSync(dir)) {
    if (!(await worktreeIsClean(dir).catch(() => false))) {
      throw new Error(
        `worktree ${dir} has uncommitted changes from an earlier run.\n`
        + `  Inspect it, then commit or discard the changes and re-run.\n`
        + `  To discard: git -C ${dir} reset --hard && git worktree remove ${dir}`,
      );
    }
    await removeWorktree(dir).catch(() => {});
  }
  await git(['worktree', 'prune']).catch(() => {});
  await git(['branch', '-D', branch]).catch(() => {});
  await git(['worktree', 'add', '-b', branch, dir, baseSha]);
  return { dir, branch };
}

/**
 * Pick the commit a task's worktree starts from, and merge in any further
 * dependencies.
 *
 * `dependsOn` has to mean more than ordering: a task declaring a dependency
 * expects that dependency's *output* as its input. Branching every task from
 * the run's base would order them correctly and still hand each one a tree
 * without the work it was told to build on.
 *
 * Dependencies that passed without producing a commit contribute nothing and
 * are skipped. A conflict between two dependencies is a decomposition error,
 * so it fails the task loudly rather than being resolved here.
 */
async function baseForTask(task, results) {
  const tips = task.dependsOn
    .map((dep) => results.get(dep)?.commit)
    .filter((commit) => typeof commit === 'string' && commit.length > 0);
  return { base: tips[0] ?? null, merges: tips.slice(1) };
}

async function mergeDependencies(worktreeDir, merges) {
  for (const commit of merges) {
    try {
      await git(['merge', '--no-edit', commit], worktreeDir);
    } catch (err) {
      await git(['merge', '--abort'], worktreeDir).catch(() => {});
      throw new Error(
        `merging dependency ${commit.slice(0, 8)} conflicted.\n`
        + `  Two dependencies changed the same lines — the board is split along the wrong seam.\n`
        + `  ${err.message.split('\n')[0]}`,
      );
    }
  }
}

async function worktreeIsClean(dir) {
  const status = await git(['status', '--porcelain'], dir);
  return status === '';
}

async function removeWorktree(dir, { force = false } = {}) {
  const args = ['worktree', 'remove'];
  if (force) args.push('--force');
  args.push(dir);
  await git(args);
}

/* ─────────────────────────────────────────────────────────────
   Codex invocation
   ───────────────────────────────────────────────────────────── */

/**
 * Build the `codex exec` argv for one attempt.
 *
 * Flags are the documented non-interactive surface:
 *   --json                 JSONL events on stdout
 *   -o/--output-last-message   final assistant message to a file
 *   -C/--cd                working root
 *   -s/--sandbox           sandbox policy
 *   -m/--model             model override
 *
 * We never pass --dangerously-bypass-approvals-and-sandbox. A task that
 * needs more reach should widen the sandbox explicitly in the board.
 */
function buildCodexArgs(task, runDir, worktreeDir, prompt) {
  const args = ['exec', '--json', '--color', 'never'];
  args.push('-C', worktreeDir);
  args.push('-o', path.join(runDir, 'last.md'));
  if (task.sandbox) args.push('-s', task.sandbox);
  if (task.model) args.push('-m', task.model);
  args.push(prompt);
  return args;
}

function shellQuote(value) {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * Run one Codex session. Resolves with an outcome record; it does not throw
 * on a non-zero exit, because a failed player is data the conductor needs.
 */
function runCodex(task, runDir, worktreeDir, prompt, log) {
  const args = buildCodexArgs(task, runDir, worktreeDir, prompt);
  const eventsPath = path.join(runDir, 'events.jsonl');
  const stderrPath = path.join(runDir, 'stderr.log');

  return new Promise((resolve) => {
    const events = fs.createWriteStream(eventsPath, { flags: 'a' });
    const stderr = fs.createWriteStream(stderrPath, { flags: 'a' });
    const started = Date.now();

    let child;
    try {
      // `detached` puts the child in its own process group so a timeout can
      // signal the whole group. Killing only the direct `codex` process would
      // leave its descendants — compilers, test runners, package managers —
      // still writing to the worktree while verification reads it.
      child = spawn('codex', args, {
        cwd: REPO_ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      events.end();
      stderr.end();
      resolve({ ok: false, reason: `spawn failed: ${err.message}`, code: null, ms: 0 });
      return;
    }

    let settled = false;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      events.end();
      stderr.end();
      resolve({ ...outcome, ms: Date.now() - started });
    };

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log(`timeout after ${task.timeoutMs}ms — killing the process tree`);
      killTree(child);
      // Do not settle here. Waiting for 'close' means the descendants have
      // stopped touching the worktree before verification looks at it.
      setTimeout(() => {
        finish({ ok: false, reason: `timeout after ${task.timeoutMs}ms (tree did not exit)`, code: null });
      }, 10_000).unref?.();
    }, task.timeoutMs);

    child.stdout.pipe(events);
    child.stderr.pipe(stderr);

    child.on('error', (err) => {
      const hint = err.code === 'ENOENT'
        ? 'codex CLI not found on PATH — install it or use --dry-run'
        : err.message;
      finish({ ok: false, reason: hint, code: null });
    });

    child.on('close', (code) => {
      if (timedOut) {
        finish({ ok: false, reason: `timeout after ${task.timeoutMs}ms`, code: null });
        return;
      }
      finish({ ok: code === 0, reason: code === 0 ? null : `codex exited ${code}`, code });
    });
  });
}

/**
 * Kill a child and everything it spawned.
 *
 * Node has no cross-platform process-tree kill and this harness carries no
 * dependencies, so each platform gets its own one-liner: a negative pid
 * signals the process group on POSIX, `taskkill /T` walks the tree on Windows.
 */
function killTree(child) {
  if (!child.pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL'); // negative pid: the whole group
  } catch {
    child.kill('SIGKILL'); // group already gone, or never created
  }
}

/* ─────────────────────────────────────────────────────────────
   Verification loop (§21)
   ───────────────────────────────────────────────────────────── */

/**
 * The harness — not the model — decides whether a task is done. The verify
 * command runs in the task's own worktree; its output is the evidence.
 *
 * TRUST BOUNDARY: `verify` is a shell command line by design — real checks
 * need pipes, `&&`, and redirection (`npm run lint && npm run test -- src/x`).
 * The board therefore sits at the same trust level as `package.json` scripts,
 * a Makefile, or this file: whoever can write it can already run code here.
 * Review board changes in PRs the way you review scripts.
 *
 * Splitting on whitespace and dropping `shell` would not move that boundary —
 * `sh -c '...'` survives it — while silently mis-running every compound
 * command, so it is not done. Keep untrusted boards out instead; `--board`
 * warns when the file comes from outside the repo.
 */
async function verify(task, worktreeDir) {
  if (!task.verify) return { passed: true, output: '(no verify command configured)' };
  try {
    const { stdout, stderr } = await execFileAsync(task.verify, {
      cwd: worktreeDir,
      shell: true,
      timeout: task.timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { passed: true, output: `${stdout}${stderr}`.slice(-4000) };
  } catch (err) {
    const output = `${err.stdout ?? ''}${err.stderr ?? ''}${err.message}`.slice(-4000);
    return { passed: false, output };
  }
}

function retryPrompt(task, failureOutput) {
  return [
    task.prompt,
    '',
    '---',
    'A previous attempt was rejected by the verification command.',
    `Command: ${task.verify}`,
    'Output (tail):',
    '```',
    failureOutput,
    '```',
    'Fix the cause, then make the command pass. Do not disable or weaken the check.',
  ].join('\n');
}

/* ─────────────────────────────────────────────────────────────
   Per-task driver
   ───────────────────────────────────────────────────────────── */

async function runTask(task, ctx, results) {
  const log = (msg) => process.stdout.write(`[${task.id}] ${msg}\n`);
  const runDir = path.join(RUNS_ROOT, task.id);

  // --dry-run is documented as writing nothing, so it must not create the run
  // directory either. Plan, print, return.
  if (ctx.dryRun) {
    const worktreeDir = path.join(WORKTREE_ROOT, task.id);
    const argv = buildCodexArgs(task, runDir, worktreeDir, task.prompt);
    log(`would run: codex ${argv.map(shellQuote).join(' ')}`);
    if (task.verify) log(`would verify with: ${task.verify}`);
    return { id: task.id, status: 'planned', branch: `${BRANCH_PREFIX}${task.id}`, attempts: [] };
  }

  await fsp.mkdir(runDir, { recursive: true });

  const { base, merges } = await baseForTask(task, results);
  if (base) log(`branching from dependency ${base.slice(0, 8)}`);
  const { dir: worktreeDir, branch } = await createWorktree(task.id, base ?? ctx.baseSha);
  if (merges.length > 0) {
    log(`merging ${merges.length} further dependenc${merges.length === 1 ? 'y' : 'ies'}`);
    await mergeDependencies(worktreeDir, merges);
  }

  const attempts = [];
  let prompt = task.prompt;
  const budget = Math.max(1, task.verifyRetries + 1);

  for (let attempt = 1; attempt <= budget; attempt += 1) {
    log(`attempt ${attempt}/${budget} — codex exec (sandbox=${task.sandbox})`);
    const run = await runCodex(task, runDir, worktreeDir, prompt, log);

    if (!run.ok) {
      attempts.push({ attempt, phase: 'codex', passed: false, reason: run.reason, ms: run.ms });
      log(`codex failed: ${run.reason}`);
      break; // a broken player is not fixed by asking again
    }

    const verdict = await verify(task, worktreeDir);
    attempts.push({ attempt, phase: 'verify', passed: verdict.passed, reason: verdict.passed ? null : 'verify failed', ms: run.ms });

    if (verdict.passed) {
      log(`verified after ${attempt} attempt(s)`);
      const commit = await commitIfDirty(worktreeDir, task);
      return { id: task.id, status: 'passed', branch, commit, attempts };
    }

    log(`verify failed${attempt < budget ? ' — retrying with feedback' : ' — budget spent'}`);
    prompt = retryPrompt(task, verdict.output);
  }

  const commit = await commitIfDirty(worktreeDir, task);
  return { id: task.id, status: 'failed', branch, commit, attempts };
}

/**
 * Commit whatever the worker produced, pass or fail. A failed attempt that
 * left useful work behind should still be reviewable; an empty worktree
 * commits nothing.
 */
async function commitIfDirty(worktreeDir, task) {
  if (await worktreeIsClean(worktreeDir)) return null;
  await git(['add', '-A'], worktreeDir);
  await git(['commit', '-m', `orchestra(${task.id}): ${task.title}`], worktreeDir);
  return git(['rev-parse', 'HEAD'], worktreeDir);
}

/* ─────────────────────────────────────────────────────────────
   Scheduler — dependency-aware concurrency pool (§13)
   ───────────────────────────────────────────────────────────── */

async function schedule(tasks, ctx) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const results = new Map();

  // A task already recorded as passed stays passed unless --fresh cleared it.
  for (const task of tasks) {
    const prior = ctx.state.tasks[task.id];
    if (prior?.status === 'passed') {
      results.set(task.id, { ...prior, id: task.id, status: 'skipped' });
      process.stdout.write(`[${task.id}] already passed — skipping (use --fresh to re-run)\n`);
    }
  }

  const pending = new Set(tasks.filter((t) => !results.has(t.id)).map((t) => t.id));
  const running = new Map();

  // 'planned' only occurs under --dry-run, where nothing really ran and the
  // point is to print the whole plan rather than stop at the first frontier.
  const CLEARS = new Set(['passed', 'skipped', 'planned']);

  const depsSatisfied = (id) => byId.get(id).dependsOn.every((dep) => CLEARS.has(results.get(dep)?.status));

  const depsBlocked = (id) => byId.get(id).dependsOn.some((dep) => {
    const r = results.get(dep);
    return r && !CLEARS.has(r.status);
  });

  while (pending.size > 0 || running.size > 0) {
    for (const id of [...pending]) {
      if (running.size >= ctx.concurrency) break;
      if (depsBlocked(id)) {
        pending.delete(id);
        results.set(id, { id, status: 'blocked', attempts: [], branch: null });
        process.stdout.write(`[${id}] blocked — a dependency did not pass\n`);
        continue;
      }
      if (!depsSatisfied(id)) continue;
      pending.delete(id);
      running.set(id, runTask(byId.get(id), ctx, results).then(
        (r) => ({ id, result: r }),
        (err) => ({ id, result: { id, status: 'failed', branch: null, attempts: [{ attempt: 1, phase: 'harness', passed: false, reason: err.message }] } }),
      ));
    }

    if (running.size === 0 && pending.size > 0) {
      // Nothing runnable and nothing in flight: the rest can never start.
      for (const id of pending) results.set(id, { id, status: 'blocked', attempts: [], branch: null });
      break;
    }

    if (running.size === 0) break;
    const { id, result } = await Promise.race(running.values());
    running.delete(id);
    results.set(id, result);
    ctx.state.tasks[id] = result;
    if (!ctx.dryRun) await saveState(ctx.state);
  }

  return results;
}

/* ─────────────────────────────────────────────────────────────
   Report
   ───────────────────────────────────────────────────────────── */

const STATUS_MARK = { passed: '✅', failed: '❌', blocked: '⛔', skipped: '⏭️', planned: '📋' };

async function writeReport(results, ctx) {
  const rows = [...results.values()];
  const lines = [
    '# Orchestra run report',
    '',
    `- Conductor: Claude Code · Players: \`codex exec\``,
    `- Base: \`${ctx.baseSha ?? 'n/a'}\``,
    `- Concurrency: ${ctx.concurrency}`,
    `- Finished: ${new Date().toISOString()}`,
    '',
    '| | Task | Status | Branch | Attempts |',
    '| --- | --- | --- | --- | --- |',
  ];
  for (const r of rows) {
    lines.push(`| ${STATUS_MARK[r.status] ?? '?'} | \`${r.id}\` | ${r.status} | ${r.branch ? `\`${r.branch}\`` : '—'} | ${r.attempts?.length ?? 0} |`);
  }
  lines.push('', '## Detail', '');
  for (const r of rows) {
    lines.push(`### \`${r.id}\` — ${r.status}`, '');
    if (r.commit) lines.push(`Commit: \`${r.commit}\``, '');
    for (const a of r.attempts ?? []) {
      lines.push(`- attempt ${a.attempt} · ${a.phase} · ${a.passed ? 'pass' : 'fail'}${a.reason ? ` · ${a.reason}` : ''}`);
    }
    lines.push('', `Events: \`.orchestra/runs/${r.id}/events.jsonl\` · Final message: \`.orchestra/runs/${r.id}/last.md\``, '');
  }
  await fsp.mkdir(RUN_ROOT, { recursive: true });
  await fsp.writeFile(REPORT_FILE, `${lines.join('\n')}\n`);
}

/* ─────────────────────────────────────────────────────────────
   Main
   ───────────────────────────────────────────────────────────── */

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const allTasks = await loadBoard(opts.board);
  const tasks = selectTasks(allTasks, opts.only);

  const ctx = {
    concurrency: opts.concurrency,
    dryRun: opts.dryRun,
    state: await loadState(opts.fresh),
    baseSha: opts.dryRun ? null : await resolveBaseRef(opts.baseRef),
  };

  process.stdout.write(`orchestra: ${tasks.length} task(s), concurrency ${ctx.concurrency}${opts.dryRun ? ' (dry run)' : ''}\n`);

  const results = await schedule(tasks, ctx);

  if (!opts.dryRun && !opts.keepWorktrees) {
    for (const r of results.values()) {
      if (r.status === 'planned' || r.status === 'skipped' || r.status === 'blocked') continue;
      const dir = path.join(WORKTREE_ROOT, r.id);
      // Clean worktrees carry no unreviewed work, so removing them is safe.
      // Dirty ones stay on disk for a human to look at.
      if (await worktreeIsClean(dir).catch(() => false)) {
        await removeWorktree(dir).catch(() => {});
      }
    }
  }

  // A dry run must not overwrite the report from the last real run.
  if (!opts.dryRun) await writeReport(results, ctx);

  const rows = [...results.values()];
  const failed = rows.filter((r) => r.status === 'failed' || r.status === 'blocked');
  process.stdout.write(`\n${rows.length - failed.length}/${rows.length} ok · report at .orchestra/report.md\n`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`orchestra: ${err.message}\n`);
  process.exit(2);
});
