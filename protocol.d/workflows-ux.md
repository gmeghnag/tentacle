workflows-ux: a `workflows` run row carries its definition edges and its history, all REQUIRED.
Each `WorkflowStepRow` gains `next` (the resolved pass target, null = the run ends),
`onFail` ({goto, max, taken}, null = stop) and `retry`; each `WorkflowRow` gains `history`
(the latest 64 finished executions) and `historyDropped`. Required so an older daemon fails at
`initialize` with VersionMismatch instead of an app drawing a run graph with no edges
(docs/fix/workflows-ux.md D1).
