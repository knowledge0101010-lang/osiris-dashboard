---
name: Harness Review
description: Review an agent harness — an AGENTS.md/CLAUDE.md, a set of tools or hooks, an orchestration script, a verification loop — against the 24-layer harness architecture, and produce findings plus a removal list. Use when the user asks to review, audit, or harden agent scaffolding; asks "is my harness any good"; adds tools, skills, subagents, hooks, permissions, or a verification loop; or before shipping agent tooling to a team. Also use when a harness is unreliable and the cause is unclear.
version: 1.0.0
---

# Harness Review

You are reviewing **the scaffolding around a model**, not the model and not the
application code it edits. The subject is the harness: the loop, the tools, the
permission gate, the context strategy, the verification, the observability.

The full theory lives in [`docs/anthropic-academy/`](../../../docs/anthropic-academy/).
This skill is the operational form of it.

## The one principle that orders everything else

> **Every harness layer exists because the model cannot do something yet.**
> That makes each layer a bet on a model generation. When the bet expires, the
> layer stops helping and starts costing.

So a harness review has two halves, and most reviews only do the first:

1. **What is missing or broken?**
2. **What should be deleted?**

A review that only adds is a review that makes the harness worse over time.

## Scope check — is this even a harness?

Four elements are necessary and sufficient. If the subject lacks one, say so
before reviewing anything else, because the gap explains most symptoms:

| Element | Absent means |
| --- | --- |
| Agent loop | It is a prompt wrapper. Nothing acts. |
| Tool interface | The model can decide but not do. |
| Context management | Long sessions die or degrade. |
| Control mechanisms | Nothing gates side effects or stops runaway. |

A generator, a guardrail, or a tool wrapper is not a harness. Review it as what
it is rather than reporting eighteen missing layers.

## Procedure

### 1. Map before judging

Find and read, in this order:

- instruction files (`CLAUDE.md`, `AGENTS.md`, nested ones)
- tool/skill/subagent definitions
- hooks and permission config
- any orchestration or loop code
- verification commands and where they run
- trace/log output

State what exists. Do not report a layer as missing until you have looked for it.

### 2. Score each layer

Walk [`references/checklist.md`](references/checklist.md). For each item:
**pass**, **fail**, or **n/a with a written reason**. "n/a" without a reason is a
fail. Anchor every finding to a file and line.

### 3. Separate the four failure classes

Reliability problems map to harness components. Naming the class points at the fix:

| Class | Symptom | Component |
| --- | --- | --- |
| **Context** | Forgets constraints, degrades over a long session, repeats reads | §8 compaction, §10 prompt assembly |
| **Constraint** | Does things it was told not to, edits out of scope | §3 permissions, §4 hooks — *not* more prompt text |
| **Verification** | Claims done when it is not, weakens checks to pass | §21 verification loop, separate grader |
| **Planning** | Wanders, redoes work, no progress across sessions | §5 plan artifacts, §12 task records |

A constraint failure fixed with a stronger prompt will come back. Say that.

### 4. Write the removal list

For every layer that exists, fill [`references/removal-list.md`](references/removal-list.md):
what capability gap it covers, and what observable change makes it unnecessary.

**Four things never go on that list**, because they encode trust boundaries and
cost decisions rather than model limitations: permissions, budget ceilings,
observability, and evaluation. If someone proposes removing one of these
"because the model got better", that is a category error — say so.

### 5. Report

Findings first, ordered by consequence. For each:

```
<layer §N> · <file:line>
Claim:    one sentence — what is wrong
Evidence: what you read that shows it
Fix:      the specific change
Class:    context | constraint | verification | planning
```

Then the removal list. Then, if you found none of the above, say the harness is
sound and name the two or three layers you checked hardest — a review that
reports nothing without saying what it looked at is not evidence of anything.

## Rules

- **Prompt text is not a control.** If a rule must hold, it belongs in a hook or
  a permission gate. Recommend the mechanism, not stronger wording.
- **Exit codes are the floor, not the ceiling.** A verification loop cannot catch
  a worker that weakened the check. Every harness with automated verification
  also needs a diff review step; name who or what does it.
- **More harness is not better.** If a layer duplicates something the current
  model does unprompted, that is a finding — it burns tokens and can fight the
  model.
- **Do not recommend a framework.** Recommend the missing mechanism. Which
  library provides it is the user's call.
- **Measure before restructuring.** If there are no traces and no evals, the
  first finding is that, because nothing else can be verified as an improvement.
