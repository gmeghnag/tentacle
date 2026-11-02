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
 * Bytes (JSON length) of the updates kept while opening/resyncing; past it a
 * new one is dropped, and the hole it leaves is a gap. It must hold every
 * replay the daemon legitimately sends: a resync replays everything after the
 * cut — the whole round in flight, which the daemon's ring pins however long
 * (`daemon/src/ring.ts`) — so a bound below that loses part of the replay on
 * every reopen and never converges (docs/fix/detach-live.md, round 9). Far
 * above the ring (4 MiB) and a WebSocket's backpressure limit (16 MiB); it only
 * bounds a hostile pod that streams without answering `open`.
 */
export const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;

/**
 * Updates held while opening/resyncing: `items[0..length)`, sorted by seq,
 * unique. `items` is shared by the states that hold it — a later state may
 * extend it past this one's `length`, never write below it — so an in-order
 * append is O(1) and the reducer stays pure.
 */
export interface Held {
  readonly items: readonly SessionUpdateParams[];
  readonly length: number;
  /** JSON length of `items[0..length)`. */
  readonly bytes: number;
}

export const NOTHING_HELD: Held = { items: [], length: 0, bytes: 0 };

/** A `Held` of `updates` (sorted by seq, unique). */
export function heldOf(updates: readonly SessionUpdateParams[]): Held {
  return { items: [...updates], length: updates.length, bytes: sizeOfAll(updates) };
}

/** The held updates, in seq order (a copy). */
export function heldList(held: Held): SessionUpdateParams[] {
  return held.items.slice(0, held.length);
}

function sizeOfAll(updates: readonly SessionUpdateParams[]): number {
  let bytes = 0;
  for (const params of updates) bytes += JSON.stringify(params).length;
  return bytes;
}

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
  readonly buffer: Held;
  /** The turn running as far as this stream shows. */
  readonly turn: string | null;
  /** Permission requests streamed and not resolved. */
  readonly pending: readonly string[];
  /** When each recent forced reopen happened (the guard). */
  readonly reopens: readonly number[];
  /** Unknown update types already reported (`unsupported`: once per type per session). */
  readonly unsupported: readonly string[];
}

export const initialStream: StreamState = {
  phase: "idle",
  epoch: null,
  applied: 0,
  buffer: NOTHING_HELD,
  turn: null,
  pending: [],
  reopens: [],
  unsupported: [],
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
  | {
      readonly kind: "update";
      readonly seq: number;
      readonly update: SessionUpdate;
      /**
       * The turn the update belongs to, by the stream's brackets: the running
       * turn as of this update, null outside turns (and for a `turn_end` that
       * closes no started turn). Session-level updates carry it too; their
       * consumers ignore it (docs/feat/tui-foreign-turns.md).
       */
      readonly turn: string | null;
    }
  /** A frame this client cannot act on (malformed known type, unknown mandatory). */
  | { readonly kind: "error"; readonly error: Error }
  /** The first frame of an unknown display type in this session (then skipped). */
  | { readonly kind: "unsupported"; readonly type: string }
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

/** Buffer one update: sorted by seq, a duplicate seq kept once, none past `MAX_BUFFERED_BYTES`. */
function buffered(held: Held, params: SessionUpdateParams): Held {
  const { items, length } = held;
  // Binary search for the first entry with seq >= params.seq (usually the end).
  let lo = 0;
  let hi = length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((items[mid] as SessionUpdateParams).seq < params.seq) lo = mid + 1;
    else hi = mid;
  }
  if (lo < length && items[lo]?.seq === params.seq) {
    return held;
  }
  const bytes = held.bytes + JSON.stringify(params).length;
  if (bytes > MAX_BUFFERED_BYTES) {
    return held;
  }
  if (lo === length && length > 0 && items.length === length) {
    // The common case, in order and nobody extended `items` yet: append in place.
    (items as SessionUpdateParams[]).push(params);
    return { items, length: length + 1, bytes };
  }
  const next = [...items.slice(0, lo), params, ...items.slice(lo, length)];
  return { items: next, length: next.length, bytes };
}

/** Request ids the buffered updates past `seq` leave pending (in order). */
function pendingIn(held: Held, seq: number): string[] {
  const pending: string[] = [];
  for (let i = 0; i < held.length; i++) {
    const params = held.items[i] as SessionUpdateParams;
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
      this.set({ phase: "failed", buffer: NOTHING_HELD, reopens });
      this.out.push({ kind: "failed", reason });
      return;
    }
    this.set({ phase: "resyncing", epoch: null, buffer: NOTHING_HELD, reopens });
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
    if (classified.kind === "unsupported") {
      // An unknown display event: counted; reported once per type, then skipped.
      if (!this.state.unsupported.includes(classified.type)) {
        this.set({ unsupported: [...this.state.unsupported, classified.type] });
        this.out.push({ kind: "unsupported", type: classified.type });
      }
      return;
    }
    if (classified.kind === "error") {
      this.out.push({ kind: "error", error: classified.error });
      return;
    }
    const update = classified.update;
    // The turn this update belongs to, as of THIS update (one step can drain
    // several turns): its own id for a start, the turn it closes for an end
    // (null for an unstarted send-now's), else the turn running.
    let turn = this.state.turn;
    switch (update.type) {
      case "turn_start":
        this.set({ turn: update.turnId });
        turn = update.turnId;
        break;
      case "turn_end":
        if (this.state.turn === update.turnId) this.set({ turn: null });
        else turn = null;
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
    this.out.push({ kind: "update", seq: params.seq, update, turn });
    if (update.type === "history_replaced") {
      // The barrier: nothing after it may be applied over the old history.
      this.set({ phase: "resyncing", epoch: null, buffer: NOTHING_HELD });
      this.effects.push({ kind: "fetch_snapshot" });
    } else if (update.type === "session_closed") {
      this.set({ phase: "closed", buffer: NOTHING_HELD, turn: null, pending: [] });
    }
  }

  /** Go live and apply `buffer` in seq order; what follows a barrier stays buffered. */
  drain(buffer: Held, now: number): void {
    this.set({ phase: "live", buffer: NOTHING_HELD });
    for (let i = 0; i < buffer.length; i++) {
      const params = buffer.items[i] as SessionUpdateParams;
      this.apply(params, now);
      if (this.state.phase === "resyncing" && this.effects.at(-1)?.kind === "fetch_snapshot") {
        this.set({ buffer: heldOf(buffer.items.slice(i + 1, buffer.length)) });
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
      s.set({ phase: "opening", buffer: NOTHING_HELD });
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
        s.set({ phase: "down", buffer: NOTHING_HELD });
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
      s.set({ phase: "failed", buffer: NOTHING_HELD });
      s.out.push({ kind: "failed", reason: input.reason });
      break;
  }
  return { state: s.state, out: s.out, effects: s.effects };
}
