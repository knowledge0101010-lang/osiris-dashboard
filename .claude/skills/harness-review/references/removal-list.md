# Removal list

The half of a harness review that almost never gets done.

Every layer was added because the model of the day could not do something. When
that changes, the layer does not become neutral — it becomes a cost: code to
maintain, tokens to spend, and a workaround that can actively fight a model that
no longer needs it. The only way anyone ever deletes it is if the condition was
written down while the reason was still fresh.

## Fill this in

| Layer | Exists because (model limitation) | Remove when | How you would know |
| --- | --- | --- | --- |
| | | | |
| | | | |
| | | | |

**Column rules**

- **Exists because** — name the *model limitation*. "It's convenient" is not one;
  neither is "best practice". If you cannot name the limitation, that is the
  finding: nobody knows why this layer is here, so nobody will ever remove it.
- **Remove when** — a condition about capability, not a date.
- **How you would know** — something observable. Usually: turn the layer off, run
  the eval set, see whether the score moves.

## Never on this list

These four are not bets on model capability, so no model improvement retires them:

| Layer | Why it stays |
| --- | --- |
| **Permissions** (§3) | A decision about the blast radius you can absorb, not about whether the model is careful. "The model is trustworthy now, drop the gate" is a category error. |
| **Budget ceilings** (§11, §21) | A decision about spend. A more capable model can burn a budget faster, not slower. |
| **Observability** (§20) | You cannot debug what you cannot see. Capability does not make runs self-explaining. |
| **Evaluation** (§23) | Required to retire anything else. Without it, deletion is a guess. |

Note the dependency: **§20 and §23 are what make the rest of this list actionable.**
A harness with no traces and no evals can never safely delete a layer, so it
accumulates them permanently. If both are missing, that is the first finding of
the review and everything else waits behind it.

## Worked example

| Layer | Exists because | Remove when | How you would know |
| --- | --- | --- | --- |
| Forced plan-mode gate | Model started editing before understanding the task | Model reliably reads enough before editing | Disable on a 20-task eval set; compare edit-correctness and files-touched |
| Retry ladder for tool errors | Model gave up on the first transient failure | Model retries transient failures itself | Inject a flaky tool; count recoveries without the ladder |
| Directory-map context injection | Model wasted turns exploring structure | Model navigates large repos efficiently unaided | Compare turns-to-first-edit with injection off |
| Explicit "do not weaken tests" rule | Model deleted assertions to reach green | Never — this is a constraint, not a capability gap | Belongs in a hook and a diff review, not this table |

The last row is the common mistake: a **constraint** dressed up as a capability
gap. Constraints do not expire. Move them to §3/§4 and leave them there.
