/**
 * Image thumbnails for the transcript (12b; the owner's added requirement:
 * "image attachments (media_message refs) are shown in the transcript … never
 * auto-downloaded beyond the visible rows").
 *
 * What this module decides, purely:
 * - WHICH images want bytes: only those on rows a `FlatList` currently shows
 *   (plus the window either side), never the whole history;
 * - WHEN: a request is issued once per image id, and the in-flight set is
 *   bounded (`MAX_IN_FLIGHT`), so a fast scroll cannot flood the channel — an
 *   id that scrolls out of the window is **cancelled** on its own controller,
 *   never merely forgotten;
 * - what happens on arrival / failure, and when the cache must drop an id.
 *
 * One mounted screen owns one `createThumbnailDriver`: it keeps the state and
 * the controllers across every window change, because a per-window call cannot
 * (review round 1's two findings — a shared signal left N × `MAX_IN_FLIGHT`
 * fetches running, and a stale window's settle rolled back a newer one's).
 *
 * What it does NOT decide: how the bytes travel. That is an injected
 * `fetchThumbnail` port (`ThumbnailSource`). **The transport does not exist
 * yet**: the protocol has no method that reads an image back
 * (`attachment/put` is client → daemon only; docs/feat/attachments-upload.md
 * "No `attachment/get` / `status` method …. nothing reads bytes back over the
 * wire"). So the port stays unimplemented until a task adds one — an additive
 * new method, no `PROTOCOL_VERSION` bump (AGENTS §7). Until then the screen
 * draws the label `[image: name]`, which is what this build can honestly show.
 * Recorded in the task doc's Execution (§ Drift) rather than guessed at here.
 */
import type { ImageRef } from "./transcript-rows.ts";

/** Thumbnails held at once: an id is dropped in LRU order past this. */
export const MAX_CACHED = 60;

/** Requests in flight at once (a fast scroll must not open fifty dialogs' worth). */
export const MAX_IN_FLIGHT = 4;

/** Rows either side of the visible window that are pre-fetched (a flick is instant). */
export const PREFETCH_ROWS = 8;

/** Bytes a thumbnail request may carry (`MAX_IMAGE_BYTES`-bounded above by the wire). */
export type Thumbnail = { readonly id: string; readonly uri: string };

/**
 * How the bytes arrive. Injected, so the pure decisions are testable now and the
 * transport can be wired when it exists (AGENTS §7: the seam, not the guess).
 */
export interface ThumbnailSource {
  /** Resolve an image's displayable URI, or null when it cannot be shown. */
  fetch(ref: ImageRef, signal: AbortSignal): Promise<Thumbnail | null>;
}

export interface ThumbnailState {
  /** URI by image id: the loaded thumbnails, least-recently-wanted last. */
  readonly loaded: readonly Thumbnail[];
  /** Ids a request is running for. */
  readonly inFlight: readonly string[];
  /** Ids that failed (never retried this session: the bytes are not coming). */
  readonly failed: readonly string[];
}

export const initialThumbnails: ThumbnailState = { loaded: [], inFlight: [], failed: [] };

export interface Request {
  readonly ref: ImageRef;
  /**
   * This request's OWN controller: the driver never hands out one shared signal,
   * because an off-window request must be cancellable on its own. The driver's
   * unmount signal aborts every controller it started.
   */
  readonly controller: AbortController;
}

/** One step: what the driver should start, what it should abort, and the state. */
export interface Plan {
  readonly start: readonly Request[];
  /** Ids no longer in the visible window whose fetch should be abandoned. */
  readonly abort: readonly string[];
  /** The controllers of the requests still wanted after this step. */
  readonly pending: ReadonlyMap<string, AbortController>;
  readonly state: ThumbnailState;
}

/**
 * The image refs on the rows in `[first, last]`, plus `PREFETCH_ROWS` either
 * side — the ONLY rows whose images may be fetched. A duplicate id on several
 * rows is one request (the key is the ref's content hash).
 */
export function visibleRefs(
  rows: readonly { readonly kind: string }[],
  first: number,
  last: number,
): readonly ImageRef[] {
  const from = Math.max(0, first - PREFETCH_ROWS);
  const to = Math.min(rows.length - 1, last + PREFETCH_ROWS);
  const seen = new Set<string>();
  const out: ImageRef[] = [];
  for (let at = from; at <= to; at += 1) {
    const row = rows[at];
    if (row === undefined || row.kind !== "user") {
      continue;
    }
    for (const ref of (row as { readonly images?: readonly ImageRef[] }).images ?? []) {
      if (seen.has(ref.id)) {
        continue;
      }
      seen.add(ref.id);
      out.push(ref);
    }
  }
  return out;
}

/**
 * Advance one step for the given visible window: mark what to start (bounded by
 * `MAX_IN_FLIGHT`), what to abandon (off the window now), and return the state.
 * Idempotent for an unchanged window: a second call starts nothing.
 */
export function plan(
  state: ThumbnailState,
  rows: readonly { readonly kind: string }[],
  first: number,
  last: number,
  signal: AbortSignal,
  pending: ReadonlyMap<string, AbortController> = new Map(),
): Plan {
  const wanted = visibleRefs(rows, first, last);
  const wantedIds = new Set(wanted.map((ref) => ref.id));
  // Off-window requests are pointless: their bytes would be cached and never shown.
  const abort = state.inFlight.filter((id) => !wantedIds.has(id));
  const stillInFlight = state.inFlight.filter((id) => wantedIds.has(id));
  const loadedIds = new Set(state.loaded.map((thumb) => thumb.id));
  const start: Request[] = [];
  const next = new Map<string, AbortController>();
  for (const id of stillInFlight) {
    const controller = pending.get(id);
    if (controller !== undefined) {
      next.set(id, controller);
    }
  }
  let inFlight = stillInFlight;
  for (const ref of wanted) {
    if (inFlight.length >= MAX_IN_FLIGHT) {
      break;
    }
    if (loadedIds.has(ref.id) || state.failed.includes(ref.id) || inFlight.includes(ref.id)) {
      continue;
    }
    const controller = new AbortController();
    // The driver's own unmount listener aborts every request it keeps; a signal
    // that fired before this request existed must not leave it running.
    if (signal.aborted) {
      controller.abort();
    }
    start.push({ ref, controller });
    next.set(ref.id, controller);
    inFlight = [...inFlight, ref.id];
  }
  return { start, abort, pending: next, state: { ...state, inFlight } };
}

/** One thumbnail arrived. */
export function loaded(state: ThumbnailState, thumb: Thumbnail): ThumbnailState {
  const rest = state.loaded.filter((entry) => entry.id !== thumb.id);
  const next = [...rest, thumb];
  return {
    ...state,
    loaded: next.slice(-MAX_CACHED),
    inFlight: state.inFlight.filter((id) => id !== thumb.id),
  };
}

/** One request failed: recorded, never retried (a broken blob stays broken). */
export function failed(state: ThumbnailState, id: string): ThumbnailState {
  return {
    ...state,
    inFlight: state.inFlight.filter((entry) => entry !== id),
    failed: state.failed.includes(id) ? state.failed : [...state.failed, id],
  };
}

/** A request was abandoned (scrolled away / unmounted): not a failure. */
export function aborted(state: ThumbnailState, id: string): ThumbnailState {
  return { ...state, inFlight: state.inFlight.filter((entry) => entry !== id) };
}

/** The thumbnail to draw for an image id, when it is loaded. */
export function thumbnailFor(state: ThumbnailState, id: string): Thumbnail | undefined {
  return state.loaded.find((thumb) => thumb.id === id);
}

/**
 * The screen's thumbnail driver: one object per mounted transcript, so every
 * window change shares ONE state and ONE table of in-flight controllers.
 *
 * Without that sharing, two things broke (both found by review, both pinned by
 * `thumbnails.test.ts`):
 * - `plan`'s `abort` list only dropped ids from `inFlight`; the fetches kept
 *   running on the shared signal, so N window changes left N × `MAX_IN_FLIGHT`
 *   requests open — "never downloaded beyond the visible rows" was false;
 * - each `drive` call captured the state `plan` returned, so a settle from an
 *   earlier window wrote that older state over everything a later window had
 *   produced (a visible thumbnail vanished, its id was requested again).
 */
export interface ThumbnailDriver {
  /** A new visible window: start what is wanted, abort what scrolled away. */
  view(rows: readonly { readonly kind: string }[], first: number, last: number): void;
  /** The latest state (what the screen renders). */
  state(): ThumbnailState;
  /** Unmount: abort every request still running. */
  close(): void;
}

export function createThumbnailDriver(
  source: ThumbnailSource,
  onChange: (next: ThumbnailState) => void,
  unmount: AbortSignal,
  initial: ThumbnailState = initialThumbnails,
): ThumbnailDriver {
  let state = initial;
  let pending = new Map<string, AbortController>();
  const commit = (next: ThumbnailState): void => {
    state = next;
    onChange(next);
  };
  const close = (): void => {
    for (const controller of pending.values()) {
      controller.abort();
    }
    pending = new Map();
  };
  // ONE listener on the screen's signal: it reaches every request this driver
  // starts, however the window moved in between (`plan` aborts a request whose
  // window opened after the signal already fired).
  unmount.addEventListener("abort", close, { once: true });
  return {
    state: () => state,
    close,
    view: (rows, first, last) => {
      const step = plan(state, rows, first, last, unmount, pending);
      // Abandoned fetches are CANCELLED, not just forgotten: their bytes are
      // never wanted and a late arrival must not be cached.
      for (const id of step.abort) {
        pending.get(id)?.abort();
      }
      pending = new Map(step.pending);
      commit(step.state);
      for (const request of step.start) {
        const id = request.ref.id;
        const settle = (next: ThumbnailState): void => {
          // A request that was abandoned (or superseded) settles nothing: the
          // state has moved on, and this outcome is for a row nobody shows.
          if (pending.get(id) !== request.controller) {
            return;
          }
          pending.delete(id);
          commit(next);
        };
        void source.fetch(request.ref, request.controller.signal).then(
          (thumb) => {
            settle(thumb === null ? failed(state, id) : loaded(state, thumb));
          },
          () => {
            settle(failed(state, id));
          },
        );
      }
    },
  };
}
