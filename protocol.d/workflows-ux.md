workflows-ux: a `workflows` run row carries its definition edges and its history, all REQUIRED.
Each `WorkflowStepRow` gains `next` (the resolved pass target, null = the run ends),
`onFail` ({goto, max, taken}, null = stop) and `retry`; each `WorkflowRow` gains `history`
(the latest 64 finished executions) and `historyDropped`. Required so an older daemon fails at
`initialize` with VersionMismatch instead of an app drawing a run graph with no edges
(docs/fix/workflows-ux.md D1, S8b). `WorkflowCatalogueParams.sessionId` also becomes OPTIONAL (S8b,
owner Q1 = A): with no id the daemon answers the catalogue a session it creates now would read, the
`session/skills`/`session/tools` precedent — the TUI's `/workflow` panel is asked before the first
message creates a session, and `{unavailable: "not open yet"}` was a false claim. Required before,
so an older peer would refuse the id-less frame: the note covers both.

`WorkflowCatalogueResult` also LOSES `elsewhere` (S8c, owner Q2): the "workflows found higher up"
hint was removed end to end (the core lookup, the cli listing, the driver, the TUI's empty-catalogue
sentence and the phone's row), so nothing produces it. A removed field: a peer that still sends it
loses it on inbound parse (strip schemas, so this is not a parse error for the sender), but a peer
that still READS it draws a hint no one should see — hence the version bump the note asks for.
