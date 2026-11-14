# Harness review checklist

Walk in order. Each item is **pass**, **fail**, or **n/a with a written reason**.
Anchor findings to `file:line`. Section numbers refer to
[`docs/anthropic-academy/`](../../../../docs/anthropic-academy/).

---

## §0 · Foundations

- [ ] Every layer present has a stated reason for existing
- [ ] No layer duplicates something the current model does unprompted
- [ ] The task suits an agent at all: the goal can be stated, and the result can be machine-checked
- [ ] If the result cannot be machine-checked, a human judgment point is defined

> **Clear goal + no automatic check** → the loop declares done because nothing says otherwise.
> **Automatic check + unclear goal** → the loop aims at the check, proving nothing broke.
> These need different fixes. A check cannot repair a goal you cannot state.

## §1–2 · Loop and tools

- [ ] The loop has a hard step or token ceiling the model cannot talk past
- [ ] A failed tool still returns a result to the model, so it can recover
- [ ] Both the tool call and its result are appended — never one without the other
- [ ] `stop_reason` values are handled distinctly, not collapsed into "final answer"
- [ ] Tool names are unambiguous
- [ ] Tool schemas carry no fields the agent will not use
- [ ] Error messages say what to do next, not just what failed
- [ ] Return shapes are the same on success and failure
- [ ] No tool does more than one conceptual thing
- [ ] Large tool catalogs stay discoverable without loading every schema

## §3 · Permissions and sandbox

- [ ] Side effects pass a gate that is **code**, not prompt text
- [ ] The gate decides allow / ask / deny, and a denial returns a reason
- [ ] Destructive operations require explicit confirmation
- [ ] The agent runs with the minimum permissions the task needs
- [ ] Filesystem access is scoped; network access is scoped where possible
- [ ] No sandbox-bypass flag is reachable from an automated path
- [ ] Tool *combinations* were considered, not just individual tools

> **Lethal trifecta:** private data access + untrusted content + external
> communication. Each tool can be safe while the combination is not.

## §4 · Hooks

- [ ] Rules that must hold are hooks, not prompt sentences
- [ ] A failing hook fails loudly — a silent hook is no gate at all
- [ ] No hook adds meaningful latency to every tool call
- [ ] Hook output is short; it costs context like anything else

## §5 · Planning

- [ ] Non-trivial work has a plan artifact in a **file**, not only in conversation
- [ ] Each milestone names a verification **command**, not "review it"
- [ ] Scope boundaries are written down, including what is out of scope
- [ ] Decisions and deviations are recorded as they happen, not reconstructed later

## §6–7 · Subagents and skills

- [ ] Delegation is used where the exploration can be discarded, not reflexively
- [ ] Subagent briefs are self-contained — the child does not see the parent's conversation
- [ ] Returned results are shorter than what was explored, or the isolation bought nothing
- [ ] Skill descriptions state trigger conditions specifically enough to fire, narrowly enough not to misfire
- [ ] Skill bodies stay small; bulk lives in files loaded on demand
- [ ] No two skills give conflicting instructions for the same procedure

## §8 · Context

- [ ] Context is scoped to the task, not the whole codebase
- [ ] Durable state — plans, decisions, progress — lives in files
- [ ] A compaction strategy exists for sessions that outlive one window
- [ ] Cheap reductions run before lossy summarisation
- [ ] Large tool results are persisted before anything stubs them
- [ ] Stub text is byte-identical every time, including after restore
- [ ] Reduction happens at a threshold, not a little every turn — each edit rebuilds the cache
- [ ] No secrets in agent-reachable context

## §9–10 · Memory and prompt assembly

- [ ] Cross-session facts are stored outside the conversation
- [ ] Recall is scoped; stale and duplicate entries get cleaned up
- [ ] Prompt sections are ordered stable-first, dynamic-last, so the cache survives
- [ ] Instruction files hold only what is true of *this* repo
- [ ] Instruction-file durability matches the harness actually in use — post-compaction reload is not universal, and nested files usually do not reload

## §11 · Error recovery

- [ ] Failures are classified before they are retried
- [ ] Permanent failures fail fast instead of exhausting a retry budget
- [ ] Every retry path has a ceiling enforced in code
- [ ] There is an escalation path when the budget is spent
- [ ] Repeat-without-progress is detected, not just wall-clock timeout
- [ ] Exception detail goes to protected logs; the model gets a sanitised, actionable message

## §12–15 · Long-running work

- [ ] Work survives a crash — state is flushed as it completes, not at the end
- [ ] Ordering is data (a dependency graph), and cycles are rejected at load time
- [ ] A declared dependency delivers its **output**, not merely its ordering
- [ ] Only one worker can claim a unit of work
- [ ] Parallel work is isolated so two workers cannot overwrite each other
- [ ] Cleanup never discards uncommitted work — clean only, dirty preserved
- [ ] A timeout kills the whole process tree, not just the direct child
- [ ] Dry-run modes write nothing

## §19–20 · Integration and observability

- [ ] Servers and tools are activated when needed rather than all at once
- [ ] Every run leaves a trace
- [ ] Traces carry no secrets, and have scoped access plus a retention boundary
- [ ] Process metrics exist — illegal calls, step count, retries — not just outcomes
- [ ] Unattended runs report somewhere a human will look

## §21 · Verification

- [ ] "Done" is decided by something other than the model saying so
- [ ] The grader has a different context from the worker
- [ ] The rubric is fixed outside the loop
- [ ] Failure feedback rides into the retry as data
- [ ] A diff review catches what exit codes cannot — a weakened check still exits zero
- [ ] Criteria were written before the work, not after
- [ ] The autonomy level (report / assisted / unattended) is stated, and earned

## §23 · Evaluation

- [ ] An eval environment exists, not just a list of prompts
- [ ] State resets between episodes
- [ ] Rejected calls return a reason and are logged
- [ ] Tasks run more than once, so noise is distinguishable from improvement
- [ ] Outcome, process, and quality are scored separately

> Outcome passed + process failed → it got lucky.
> Process passed + outcome failed → the rules are wrong.
