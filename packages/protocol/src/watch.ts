/**
 * `session/watch` / `session/watch_next` / `session/unwatch` — a READ-ONLY
 * follower of a live session (docs/feat/logs-cmd.md, sub-task 2 `logs-watch`).
 *
 * A watcher is NOT an `Attachment`: it is never a model link, never counted by
 * `session/list`'s `attached`, never offered an ask to answer (a watcher that
 * declared no `permission_request` would otherwise make a pending ask be
 * DENIED at once — the blocking-update fallback). It only reads the session's
 * update stream, through a PULL: the daemon queues each update in a bounded
 * per-watcher queue and the client asks for the next batch (`watch_next`,
 * long-polled). That is the load-bearing shape — at most one batch is in
 * flight, so the transport carries nothing unbounded, and holding the request
 * blocks no other handler (the peer dispatches every inbound request
 * concurrently, AGENTS §7).
 *
 * Categories: `--only ask,error,turn` means the same word on both sources, so
 * the ONE map from an update to its categories lives here and the daemon's
 * filter and the CLI's `--only` cannot drift.
 *
 * Methods are free (AGENTS §7 forward compatibility): a new method needs no
 * `PROTOCOL_VERSION` bump, and an OLDER daemon answers `MethodNotFound` — which
 * the CLI turns into "this daemon is too old for `logs -f`".
 */
import { z } from "zod";
import { PermissionRequestUpdateSchema } from "./permission.ts";
import { QuestionRequestUpdateSchema } from "./question.ts";
import { SessionIdSchema, TurnIdSchema } from "./session.ts";
import { type SessionUpdate, SessionUpdateParamsSchema } from "./updates.ts";

/**
 * The `--only` / `session/watch.only` categories: the same names
 * `packages/cli/src/log-events.ts` publishes for `logs --only`, so one word
 * means one thing whether it filters a log file or the live stream.
 */
export const WATCH_CATEGORIES = [
  "ask",
  "turn",
  "error",
  "text",
  "thought",
  "tool",
  "subagent",
  "job",
  "history",
  "notice",
] as const;
export type WatchCategory = (typeof WATCH_CATEGORIES)[number];

export const WatchCategorySchema = z.enum(WATCH_CATEGORIES);

/**
 * Why a watch stopped on the daemon's side (the client says why and exits):
 * `closed` — the session was closed or deleted; `overflow` — even after
 * dropping every droppable update the queue could not hold its non-droppable
 * ones (pathological: the client never polls); `evicted` — this session has
 * {@link MAX_WATCHERS_PER_SESSION} newer watchers (the oldest goes) or this one
 * has not polled for `WATCH_IDLE_DROP_MS`.
 */
export const WatchEndReasonSchema = z.enum(["closed", "overflow", "evicted"]);
export type WatchEndReason = z.infer<typeof WatchEndReasonSchema>;

/** Watchers one session accepts; the oldest is ended `evicted` past this. */
export const MAX_WATCHERS_PER_SESSION = 8;

/** Default `watch_next` hold: long enough to be cheap, short enough to notice a dead socket. */
export const WATCH_POLL_TIMEOUT_MS = 25_000;
/** A client may not ask for a longer hold than this (a server-side bound). */
export const WATCH_POLL_TIMEOUT_MAX_MS = 60_000;

/**
 * The categories `update` belongs to — the ONE shared map (daemon filter, CLI
 * `--only`). More than one where the vocabulary overlaps: a FAILED turn's end is
 * `turn` AND `error`, and `session_closed` is `error` (its `closed` event is
 * how a follower learns the session ended). Everything a `--only` user does not
 * name is filtered BEFORE the queue, so filtered streamed text is never stored.
 */
export function watchCategoriesOf(update: SessionUpdate): readonly WatchCategory[] {
  switch (update.type) {
    case "permission_request":
    case "permission_resolved":
    case "question_request":
      return ["ask"];
    case "turn_start":
      return ["turn"];
    case "turn_end":
      return update.stopReason === "error" ? ["turn", "error"] : ["turn"];
    case "session_closed":
      return ["error"];
    case "agent_message_chunk":
      return ["text"];
    case "agent_thought_chunk":
      return ["thought"];
    case "tool_call":
    case "tool_call_update":
    case "tool_call_phase":
    case "tool_progress":
      return ["tool"];
    case "subagents":
    case "subagent_notify":
    case "subagent_message":
      return ["subagent"];
    case "jobs":
    case "background_exit":
      return ["job"];
    case "history_replaced":
      return ["history"];
    // Everything else is a notice: a plan, usage, the queue, the title, a
    // settings report, a steer, a context note, a cut-reply/empty-turn notice.
    default:
      return ["notice"];
  }
}

/**
 * Does a watcher that asked for `only` want `update`? The ONE filter rule: the
 * daemon's queue applies it before storing anything, and `session/watch`'s
 * `state.pending` applies it to the asks already on screen.
 */
export function watchAccepts(
  only: readonly WatchCategory[] | undefined,
  update: SessionUpdate,
): boolean {
  if (only === undefined) {
    return true;
  }
  return watchCategoriesOf(update).some((category) => only.includes(category));
}

/**
 * The state a fresh watch starts with: the turn running now (if any) and every
 * ask already pending — a follower that arrives mid-turn must not miss the ask
 * it is waiting for. `pending` carries the FULL request (the same shape the
 * stream sends), so the client prints it exactly like a live one.
 */
export const WatchStateSchema = z.object({
  running: z.boolean(),
  turnId: TurnIdSchema.optional(),
  /** Permission requests and remote questions (docs/feat/a2a-client.md C6). */
  pending: z.array(
    z.discriminatedUnion("type", [PermissionRequestUpdateSchema, QuestionRequestUpdateSchema]),
  ),
});
export type WatchState = z.infer<typeof WatchStateSchema>;

/**
 * `session/watch`: start watching a LIVE session. Needs no `open` and attaches
 * nothing; an unknown or archived session is `UnknownSession` — a watch never
 * revives one (use `logs --tail` on the `serve` host's store for that).
 */
export const WatchParamsSchema = z.object({
  sessionId: SessionIdSchema,
  /** Absent = every category. */
  only: z.array(WatchCategorySchema).min(1).optional(),
});
export type WatchParams = z.infer<typeof WatchParamsSchema>;

export const WATCH_ID_MAX = 128;

export const WatchResultSchema = z.object({
  /** This watch's handle, for `watch_next` / `unwatch`. */
  watchId: z.string().min(1).max(WATCH_ID_MAX),
  state: WatchStateSchema,
});
export type WatchResult = z.infer<typeof WatchResultSchema>;

/**
 * `session/watch_next`: the updates queued since the last batch (coalesced:
 * adjacent streamed text merges into one update), or an empty batch when the
 * hold times out. ONE in flight per watch (`InvalidRequest` for a second):
 * never two batches, so the client's picture is ordered by construction.
 */
export const WatchNextParamsSchema = z.object({
  watchId: z.string().min(1).max(WATCH_ID_MAX),
  /** Hold length; absent = {@link WATCH_POLL_TIMEOUT_MS}, capped at the max. */
  timeoutMs: z.number().int().nonnegative().max(WATCH_POLL_TIMEOUT_MAX_MS).optional(),
});
export type WatchNextParams = z.infer<typeof WatchNextParamsSchema>;

export const WatchNextResultSchema = z.object({
  /** In emit order, each with its own `seq` (a gap is what `lost` counts). */
  updates: z.array(SessionUpdateParamsSchema),
  /** Updates dropped from this watcher's queue since the last batch (overflow). */
  lost: z.number().int().nonnegative(),
  /** Present on the LAST batch of a watch: it has ended (see the reason). */
  ended: WatchEndReasonSchema.optional(),
});
export type WatchNextResult = z.infer<typeof WatchNextResultSchema>;

/** `session/unwatch`: stop watching (idempotent — an unknown id is a no-op success). */
export const UnwatchParamsSchema = z.object({
  watchId: z.string().min(1).max(WATCH_ID_MAX),
});
export type UnwatchParams = z.infer<typeof UnwatchParamsSchema>;

export const UnwatchResultSchema = z.object({});
export type UnwatchResult = z.infer<typeof UnwatchResultSchema>;
