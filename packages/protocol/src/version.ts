/**
 * Wire protocol version negotiated during `initialize`.
 *
 * Bump on any breaking change to the message shapes. Clients and the daemon
 * compare this during the handshake and refuse incompatible majors.
 */
// 19: a model name on `model/stream*` and `settings.publishedModels`
// (docs/feat/models-map-pod.md): an older laptop would strip the name and serve
// a named call with its main model, silently.
// 20: a `permission_request` may now arrive outside any turn and name the spawning
// turn; a sub-agent exit rides `background_exit` (docs/feat/subagent-background.md).
export const PROTOCOL_VERSION = 20 as const;
