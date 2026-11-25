/**
 * Wire protocol version negotiated during `initialize`.
 *
 * Bump on any breaking change to the message shapes. Clients and the daemon
 * compare this during the handshake and refuse incompatible majors.
 */
// 19: a model name on `model/stream*` and `settings.publishedModels`
// (docs/feat/models-map-pod.md): an older laptop would strip the name and serve
// a named call with its main model, silently.
// 20: a `permission_request` may belong to a turn other than the one streaming
// it (a background sub-agent's names its spawning turn in `turnId`; an older
// client would mis-attribute it, auto-accept included); a sub-agent exit rides
// `background_exit` (docs/feat/subagent-background.md).
// 21: `history_replaced.reason` may be `clear` (`/clear` resets the conversation
// inside the session, docs/feat/clear-keeps-jobs.md): a `mandatory` update, so
// an older client would fail the turn on it.
// 22: the `wake-` turn-id prefix is RESERVED for the daemon's own wake turns
// (docs/fix/autoaccept-wake-turns.md): `session/prompt` and `session/send_now`
// refuse a client-minted one, because a TUI with auto-accept on answers a wake
// turn's asks as its own session's. Breaking on purpose — an older `serve` does
// not refuse it, so a hand-crafted client could borrow that auto-accept for one
// `once` approval; bumping makes a mixed pair fail cleanly at `initialize`.
// 23: image refs on messages (`attachments`) plus the CRITICAL log types
// `media_message`/`media_replace` (docs/feat/attachments-core.md): an older
// peer would strip the refs silently on the wire, and an older build would
// half-load a log that holds them.
// 24: `StopReasonSchema` gained `max_token_budget` — a sub-agent's token cap
// (docs/feat/subagent-token-budget.md). A `mandatory` update carries it, so an
// older client would fail the turn on it; `subagents.maxTokens` rides
// `SessionSettings` (an additive optional field on its own, but the enum member
// forces the bump, AGENTS §7).
// 25: Agent workflows (docs/feat/agent-workflows.md D5): a permission_request whose
// tool is workflow_approve (the approval of a workflow's content hash, and a
// workflow's approve step such as a merge) must NEVER be auto-accepted. An older
// client's auto-accept would answer it allow-once, approving a merge with no human,
// so a mixed pair must fail at initialize instead. Additive in the same task: the
// session/workflow and workflow/list methods, the display update workflows, the
// snapshot field workflows, and three non-critical log entry types workflow_start,
// workflow_step and workflow_end.
// 26: Browser actions (docs/feat/browser-inspect.md B5): a permission_request whose
// tool is browser_action (a click, typing or navigation in the user's real Chrome
// that the browser tools classified as consequential: a form submit, destructive or
// payment wording, a new domain, a password field, the first action on a tab the
// user handed over) must NEVER be auto-accepted, and it is offered allow-once or
// deny only. An older client's auto-accept would answer it allow-once, acting as
// the user on the web with no human, so a mixed pair must fail at initialize
// instead.
// 27: workflows-ux: a `workflows` run row carries its definition edges and its history,
// all REQUIRED. Each `WorkflowStepRow` gains `next` (the resolved pass target, null
// = the run ends), `onFail` ({goto, max, taken}, null = stop) and `retry`; each
// `WorkflowRow` gains `history` (the latest 64 finished executions) and
// `historyDropped`. Required so an older daemon fails at `initialize` with
// VersionMismatch instead of an app drawing a run graph with no edges
// (docs/fix/workflows-ux.md D1, S8b). `WorkflowCatalogueParams.sessionId` also
// becomes OPTIONAL (S8b, owner Q1 = A): with no id the daemon answers the catalogue
// a session it creates now would read, the `session/skills`/`session/tools`
// precedent — the TUI's `/workflow` panel is asked before the first message creates
// a session, and `{unavailable: "not open yet"}` was a false claim. Required
// before, so an older peer would refuse the id-less frame: the note covers both.
// `WorkflowCatalogueResult` also LOSES `elsewhere` (S8c, owner Q2): the "workflows
// found higher up" hint was removed end to end (the core lookup, the cli listing,
// the driver, the TUI's empty-catalogue sentence and the phone's row), so nothing
// produces it. A removed field: a peer that still sends it loses it on inbound
// parse (strip schemas, so this is not a parse error for the sender), but a peer
// that still READS it draws a hint no one should see — hence the version bump the
// note asks for.
export const PROTOCOL_VERSION = 27 as const;
