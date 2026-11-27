---
name: tentacle-workflows
description: Use when the user asks to create, edit, run, schedule or debug a tentacle workflow - the YAML file in .tentacle/workflows/, its steps, inputs, approval and asks during unattended runs.
---
# tentacle workflows

A workflow is a file you write and the user approves; tentacle's code then runs
the steps in order. Workflows work in a laptop or `serve` session, not inside a
pod (`run`/`attach`).

## The file

`.tentacle/workflows/<name>.yaml`; `<name>` (lowercase letters, digits, `-`) is
also the `name:` field. Prompt files sit beside it (e.g. `prompts/plan.md`).

```yaml
schemaVersion: 1
name: review-fix
version: 1
description: review, fix, check, then merge
inputs:
  slug: { required: true }
  note: { default: "" }
budget: { tokens: 2000000, wait: 12h, max_step_runs: 50 }
steps:
  - id: review
    agent: { prompt: prompts/review.md }
    on_fail: { goto: fix, max: 3 }
    next: check
  - id: fix
    agent: { prompt_text: "Fix what the review found: {{steps.review.report}}" }
    next: review
  - id: check
    run: bun run check
    timeout: 20m
    retry: 1
  - id: merge
    approve: { title: "Merge {{inputs.slug}}" }
```

## Rules

- Each step has an `id` and exactly one of `agent`, `run` or `approve`.
- `agent`: a sub-agent run. Give exactly one of `prompt` (a file, relative to
  `.tentacle/workflows/`) or `prompt_text`. Optional `model` (a name from the
  session's `models`), `type`, `tokens`. The step passes or fails by the
  sub-agent's `step_verdict` call (`pass` or `fail` and one reason): say so in
  the prompt.
- `run`: a command; exit 0 is `pass`. `where:` is `local` (default) or
  `{ docker: <container> }`. Agent steps run locally only.
- `approve`: a human decision (`title`, optional `detail`); takes no `where` or
  `timeout`.
- `retry` re-runs the same step after `fail`. `on_fail` is `stop` (default) or
  `{ goto: <id>, max: n }`. `next` replaces the fall-through after `pass`.
- A loop must contain a counted `goto`; a loop of pass edges is refused.
- Templates only substitute `{{inputs.<name>}}`, `{{steps.<id>.reason}}` and
  `{{steps.<id>.report}}`; there are no expressions.
- Inputs are strings.

## Fields and limits

<!-- generated:workflow-limits -->
- Top-level fields: `schemaVersion`, `name`, `version`, `description`, `inputs`, `budget`, `steps` (`schemaVersion` is 1).
- Step fields: `id`, `agent`, `run`, `approve`, `where`, `timeout`, `retry`, `on_fail`, `next`.
- `agent` fields: `prompt`, `prompt_text`, `model`, `type`, `tokens`. `approve` fields: `title`, `detail`.
- `name` at most 64 characters; `description` at most 200; 1 to 64 steps.
- `retry` 0 to 5 (default 0); `on_fail.max` 1 to 10.
- `budget.max_step_runs` default 50; `budget.wait` default 12h, at most 168h.
- `timeout` (`run` steps, like `30s`, `20m`, `12h`) default 20m, at most 24h.
- `approve.title` at most 200 characters, `approve.detail` at most 2000; the step list an approval shows at most 16000.
- A run's inputs at most 4096 bytes together.
<!-- /generated:workflow-limits -->

## Approval

The first start asks the user to approve the file, showing every step and each
`run` command. The approval is bound to a hash of the YAML and its prompt files:
any edit needs a new approval. A file with errors is refused with every problem
named by its YAML path; fix them and start again.

## Run and follow

- In the TUI: `/workflow` opens the runs and the project's workflows;
  `/workflow run <name> key=value`, `/workflow stop`, `/workflow resume`,
  `/workflow approve <name>`, `/workflow delete <name> confirm`.
- On the phone: the session's menu has Workflows (start, approve, delete).
- From the agent: the `workflow` tool (`run`, `status`, `stop`). `run` returns
  at once and the result arrives as a `[workflow ...]` note; do not poll.

## Unattended runs

Steps that need a permission wait for the user (a paired phone is notified),
up to `budget.wait`, then the run stops with `timeout`. Auto-accept answers tool
asks, never the file approval or an `approve` step. One run per session at a
time.

## Schedule a start

Ask the agent to use `schedule_create` with `workflow: <name>` (and `inputs`),
plus exactly one of `every` (e.g. `2h`), `daily` (e.g. `03:00`, the host's time
zone) or `at`. The file's current content is pinned: after an edit the schedule
must be created again. `/schedule` lists and deletes schedules.
