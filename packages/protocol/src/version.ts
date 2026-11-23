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
export const PROTOCOL_VERSION = 25 as const;
