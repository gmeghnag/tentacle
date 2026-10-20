/**
 * One session's update stream, put back in order across reconnects — pure,
 * React-free, socket-free (docs/feat/client-reattach.md, Revision R1).
 *
 * The daemon stamps every update of a session with `seq` (+1 per update, per
 * incarnation, across compactions). Arrival order cannot be trusted around an
 * `open` (replayed and live updates may precede its response), so this machine
 * orders by `seq` alone:
 *
 * - updates received while an `open` or a resync is in progress are BUFFERED
 *   (from the moment `open` is sent), then applied by seq;
 * - an update with `seq <= applied` is a duplicate (dropped); one past
 *   `applied + 1` is a GAP — the client cannot repair a hole from events, so it
 *   reopens without `since` (a resync), at most 3 times a minute;
 * - a resync applies the snapshot (`reset`), then the buffered updates past
 *   its cut; `history_replaced` is a barrier that forces one.
 *
 * It keeps no transcript: consumers fold `reset` + `update` outputs. Permission
 * prompts stay with `PermissionRouter`; a `reset` only says which pending
 * requests the replay re-offers (`keepRequests`).
 */
import type { ChatMessage } from "@tentacle/core";
import type { HistoryCut, SessionUpdate, SessionUpdateParams } from "@tentacle/protocol";
import { classifyUpdate } from "./mapping.ts";

/** Forced reopens (gaps) allowed per window before the session is failed. */
export const MAX_FORCED_REOPENS = 3;
export const FORCED_REOPEN_WINDOW_MS = 60_000;
/**
 * Updates kept while opening/resyncing; past it the oldest go. Bounds memory
 * (a pod that never answers `open`) and the per-update copy; the hole the
 * evicted ones leave is a gap, so a long replay degrades to a resync.
 */
export const MAX_BUFFERED_UPDATES = 2048;

export type StreamPhase =
  /** Nothing sent yet. */
  | "idle"
  /** `open` sent: buffering until its result. */
  | "opening"
  /** Waiting for a snapshot: buffering. */
  | "resyncing"
  /** Applying updates as they come, by seq. */
  | "live"
  /** The link dropped: state kept for the next `since`. */
  | "down"
  /** The session ended daemon-side (`session_closed`). */
  | "closed"
  /** Given up (the stream kept breaking): no more reopens. */
  | "failed";

export interface StreamState {
  readonly phase: StreamPhase;
  /** Epoch of the applied stream; null when unknown (before an open, during a resync). */
  readonly epoch: string | null;
  /** Last applied seq. */
  readonly applied: number;
  /** Received while opening/resyncing, sorted by seq, unique. */
  readonly buffer: readonly SessionUpdateParams[];
  /** The turn running as far as this stream shows. */
  readonly turn: string | null;
  /** Permission requests streamed and not resolved. */
  readonly pending: readonly string[];
  /** When each recent forced reopen happened (the guard). */
  readonly reopens: readonly number[];
}

export const initialStream: StreamState = {
  phase: "idle",
  epoch: null,
  applied: 0,
  buffer: [],
  turn: null,
  pending: [],
  reopens: [],
};

export type StreamInput =
  | { readonly kind: "open_sent" }
  | { readonly kind: "update"; readonly params: SessionUpdateParams; readonly now: number }
  | {
      readonly kind: "open_result";
      readonly created: boolean;
      readonly resync: boolean;
      readonly epoch: string;
      readonly now: number;
    }
  | {
      readonly kind: "snapshot";
      readonly messages: readonly ChatMessage[];
      readonly since: HistoryCut;
      readonly turn: string | null;
      readonly now: number;
    }
  | { readonly kind: "link_down" }
  /** The daemon lost the session; it was recreated from `messages` under a new epoch. */
  | {
      readonly kind: "recreated";
      readonly epoch: string;
      readonly messages: readonly ChatMessage[];
      readonly now: number;
    }
  /** The shell could not complete a recovery step (e.g. the snapshot failed). */
  | { readonly kind: "fail"; readonly reason: string };

export type StreamOutput =
  /** Replace everything shown with `messages`; then the following updates apply on top. */
  | {
      readonly kind: "reset";
      readonly messages: readonly ChatMessage[];
      readonly turn: string | null;
      readonly keepRequests: readonly string[];
    }
  | { readonly kind: "update"; readonly seq: number; readonly update: SessionUpdate }
  /** A frame this client cannot act on (malformed known type, unknown mandatory). */
  | { readonly kind: "error"; readonly error: Error }
  /** The session was recreated: whatever turn was in flight is gone (never re-run). */
  | { readonly kind: "turn_lost" }
  | { readonly kind: "failed"; readonly reason: string };

export type StreamEffect =
  /** Page a snapshot and feed it back as one `snapshot` input. */
  | { readonly kind: "fetch_snapshot" }
  /** Open again without `since` (a resync). */
  | { readonly kind: "reopen" };

export interface StreamStep {
  readonly state: StreamState;
  readonly out: readonly StreamOutput[];
  readonly effects: readonly StreamEffect[];
}

/** The `since` to re-attach with: only while the applied position is known. */
export function sinceOf(state: StreamState): HistoryCut | undefined {
  if ((state.phase === "live" || state.phase === "down") && state.epoch !== null) {
    return { epoch: state.epoch, seq: state.applied };
  }
  return undefined;
}

/** Buffer one update: sorted by seq, a duplicate seq kept once, at most the newest `MAX_BUFFERED_UPDATES`. */
function buffered(
  buffer: readonly SessionUpdateParams[],
  params: SessionUpdateParams,
): readonly SessionUpdateParams[] {
  // Binary search for the first entry with seq >= params.seq (usually the end).
  let lo = 0;
  let hi = buffer.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((buffer[mid] as SessionUpdateParams).seq < params.seq) lo = mid + 1;
    else hi = mid;
  }
  if (buffer[lo]?.seq === params.seq) {
    return buffer;
  }
  const next = [...buffer.slice(0, lo), params, ...buffer.slice(lo)];
  return next.length > MAX_BUFFERED_UPDATES ? next.slice(next.length - MAX_BUFFERED_UPDATES) : next;
}

/** Request ids the buffered updates past `seq` leave pending (in order). */
function pendingIn(buffer: readonly SessionUpdateParams[], seq: number): string[] {
  const pending: string[] = [];
  for (const params of buffer) {
    if (params.seq <= seq) continue;
    const update = params.update as { type: string; requestId?: unknown };
    if (typeof update.requestId !== "string") continue;
    if (update.type === "permission_request" && !pending.includes(update.requestId)) {
      pending.push(update.requestId);
    } else if (update.type === "permission_resolved") {
      const at = pending.indexOf(update.requestId);
      if (at >= 0) pending.splice(at, 1);
    }
  }
  return pending;
}

class Stepper {
  state: StreamState;
  readonly out: StreamOutput[] = [];
  readonly effects: StreamEffect[] = [];

  constructor(state: StreamState) {
    this.state = state;
  }

  set(patch: Partial<StreamState>): void {
    this.state = { ...this.state, ...patch };
  }

  /** A gap: reopen without `since`, unless that already happened too often. */
  forceReopen(now: number): void {
    const reopens = [...this.state.reopens.filter((t) => now - t < FORCED_REOPEN_WINDOW_MS), now];
    if (reopens.length > MAX_FORCED_REOPENS) {
      const reason = "the daemon's update stream keeps skipping events; giving up on this session";
      this.set({ phase: "failed", buffer: [], reopens });
      this.out.push({ kind: "failed", reason });
      return;
    }
    this.set({ phase: "resyncing", epoch: null, buffer: [], reopens });
    this.effects.push({ kind: "reopen" });
  }

  /** Apply one update in `live`. */
  apply(params: SessionUpdateParams, now: number): void {
    const { applied } = this.state;
    if (params.seq <= applied) {
      return; // a duplicate (replay overlap, retried open)
    }
    if (params.seq !== applied + 1) {
      this.forceReopen(now);
      return;
    }
    this.set({ applied: params.seq });
    const classified = classifyUpdate(params);
    if (classified.kind === "ignore") {
      return; // an unknown display event: counted, not shown
    }
    if (classified.kind === "error") {
      this.out.push({ kind: "error", error: classified.error });
      return;
    }
    const update = classified.update;
    switch (update.type) {
      case "turn_start":
        this.set({ turn: update.turnId });
        break;
      case "turn_end":
        if (this.state.turn === update.turnId) this.set({ turn: null });
        break;
      case "permission_request":
        if (!this.state.pending.includes(update.requestId)) {
          this.set({ pending: [...this.state.pending, update.requestId] });
        }
        break;
      case "permission_resolved":
        this.set({ pending: this.state.pending.filter((id) => id !== update.requestId) });
        break;
      default:
        break;
    }
    this.out.push({ kind: "update", seq: params.seq, update });
    if (update.type === "history_replaced") {
      // The barrier: nothing after it may be applied over the old history.
      this.set({ phase: "resyncing", epoch: null, buffer: [] });
      this.effects.push({ kind: "fetch_snapshot" });
    } else if (update.type === "session_closed") {
      this.set({ phase: "closed", buffer: [], turn: null, pending: [] });
    }
  }

  /** Go live and apply `buffer` in seq order; what follows a barrier stays buffered. */
  drain(buffer: readonly SessionUpdateParams[], now: number): void {
    this.set({ phase: "live", buffer: [] });
    for (let i = 0; i < buffer.length; i++) {
      const params = buffer[i] as SessionUpdateParams;
      this.apply(params, now);
      if (this.state.phase === "resyncing" && this.effects.at(-1)?.kind === "fetch_snapshot") {
        this.set({ buffer: buffer.slice(i + 1) });
        return;
      }
      if (this.state.phase !== "live") {
        return; // a gap (reopen: the replay comes again) or closed/failed
      }
    }
  }
}

/** One step of the machine. Never throws; an input that does not fit the phase is ignored. */
export function reduceStream(state: StreamState, input: StreamInput): StreamStep {
  const s = new Stepper(state);
  const phase = state.phase;
  if (phase === "closed" || phase === "failed") {
    return { state, out: [], effects: [] };
  }
  switch (input.kind) {
    case "open_sent":
      s.set({ phase: "opening", buffer: [] });
      break;
    case "update":
      if (phase === "opening" || phase === "resyncing") {
        s.set({ buffer: buffered(state.buffer, input.params) });
      } else if (phase === "live") {
        s.apply(input.params, input.now);
      }
      // idle/down: a frame for no open (or a dead generation): dropped.
      break;
    case "open_result":
      if (phase !== "opening") break;
      if (input.created) {
        // A new session: its seq space starts at 0 under this epoch.
        s.set({ epoch: input.epoch, applied: 0, turn: null, pending: [] });
        s.drain(state.buffer, input.now);
      } else if (input.resync || state.epoch !== input.epoch) {
        s.set({ phase: "resyncing", epoch: null });
        s.effects.push({ kind: "fetch_snapshot" });
      } else {
        s.drain(state.buffer, input.now);
      }
      break;
    case "snapshot": {
      if (phase !== "resyncing") break;
      const keepRequests = pendingIn(state.buffer, input.since.seq);
      s.set({
        epoch: input.since.epoch,
        applied: input.since.seq,
        turn: input.turn,
        pending: [],
      });
      s.out.push({ kind: "reset", messages: input.messages, turn: input.turn, keepRequests });
      s.drain(state.buffer, input.now);
      break;
    }
    case "link_down":
      if (phase === "live" || phase === "opening" || phase === "resyncing") {
        s.set({ phase: "down", buffer: [] });
      }
      break;
    case "recreated":
      if (phase !== "opening") break;
      s.set({ epoch: input.epoch, applied: 0, turn: null, pending: [] });
      s.out.push({ kind: "turn_lost" });
      s.out.push({ kind: "reset", messages: input.messages, turn: null, keepRequests: [] });
      s.drain(state.buffer, input.now);
      break;
    case "fail":
      s.set({ phase: "failed", buffer: [] });
      s.out.push({ kind: "failed", reason: input.reason });
      break;
  }
  return { state: s.state, out: s.out, effects: s.effects };
}
