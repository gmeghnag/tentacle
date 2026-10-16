# `eval/` — evaluation tasks

Questions we are deciding, not yet committed to building: a migration, a
refactor or perf idea under consideration, a trade-off study. One doc per task:
`docs/eval/<slug>.md`, copied from `docs/TASK-TEMPLATE.md`, on branch
`eval/<slug>`.

An `eval` usually fills only **Context** and **Review** (the analysis and the
verdict); its Implementation/Execution stay empty. If it is **approved**, it is
*promoted*: `git mv` the doc into `docs/feat/` (or `docs/fix/`) and rename the
branch — the move is the decision record.

See **AGENTS.md §10** for the workflow.
