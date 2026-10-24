/**
 * `daemon/session_ttl` — read, or change, this daemon's idle TTL: how long a
 * session nobody is attached to and that runs nothing is kept loaded
 * (docs/feat/session-ttl-control.md). Daemon-wide, not a session method.
 * Additive (an older daemon answers `MethodNotFound`).
 *
 * `idleTtlMs` absent → read only; a positive integer → the new TTL; `"never"`
 * → never (a `null` is invalid, so `v ?? null` cannot set `never` by mistake). The result is the value now in force. A change lasts until the daemon
 * restarts: it is NOT persisted, the `--session-ttl` flag is the TTL at every
 * start. Applied at once (a session already past a lowered TTL goes at the
 * next sweep). A daemon without an idle reaper (a pod, the in-process worker)
 * answers `MethodNotFound`. Any authenticated client may call it (one token =
 * one principal, per-device auth is a later task).
 */
import { z } from "zod";

/** A TTL on the wire: positive whole milliseconds, or the word `"never"` (no null: absent = read). */
// A function, not a shared constant: the JSON Schema export refuses a reused anonymous schema.
const idleTtl = () =>
  z.union([z.number().int().positive().max(Number.MAX_SAFE_INTEGER), z.literal("never")]);

export const SessionTtlParamsSchema = z.object({
  idleTtlMs: idleTtl().optional(),
});
export type SessionTtlParams = z.infer<typeof SessionTtlParamsSchema>;

export const SessionTtlResultSchema = z.object({
  /** The TTL in force now (ms), or `"never"`. */
  idleTtlMs: idleTtl(),
  /**
   * Always false: a change lasts until restart (the flag wins). Lets a UI say
   * so. Widening it to a boolean is NOT additive (an older client rejects
   * `true`): persisting a runtime change needs a `PROTOCOL_VERSION` bump.
   */
  persisted: z.literal(false),
});
export type SessionTtlResult = z.infer<typeof SessionTtlResultSchema>;
