/**
 * Image thumbnails for the transcript (12b; the owner's added requirement:
 * "image attachments (media_message refs) are shown in the transcript … never
 * auto-downloaded beyond the visible rows").
 *
 * What this module decides, purely:
 * - WHICH images want bytes: only those on rows a `FlatList` currently shows
 *   (plus the window either side), never the whole history;
 * - WHEN: a request is issued once per image id, and the in-flight set is
 *   bounded (`MAX_IN_FLIGHT`), so a fast scroll cannot flood the channel;
 * - what happens on arrival / failure, and when the cache must drop an id.
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
  readonly signal: AbortSignal;
}

/** One step: what the driver should start, and what it should abort. */
export interface Plan {
  readonly start: readonly Request[];
  /** Ids no longer in the visible window whose fetch should be abandoned. */
  readonly abort: readonly string[];
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
  controller: AbortSignal,
): Plan {
  const wanted = visibleRefs(rows, first, last);
  const wantedIds = new Set(wanted.map((ref) => ref.id));
  // Off-window requests are pointless: their bytes would be cached and never shown.
  const abort = state.inFlight.filter((id) => !wantedIds.has(id));
  const stillInFlight = state.inFlight.filter((id) => wantedIds.has(id));
  const loadedIds = new Set(state.loaded.map((thumb) => thumb.id));
  const start: Request[] = [];
  let inFlight = stillInFlight;
  for (const ref of wanted) {
    if (inFlight.length >= MAX_IN_FLIGHT) {
      break;
    }
    if (loadedIds.has(ref.id) || state.failed.includes(ref.id) || inFlight.includes(ref.id)) {
      continue;
    }
    start.push({ ref, signal: controller });
    inFlight = [...inFlight, ref.id];
  }
  return { start, abort, state: { ...state, inFlight } };
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
 * Drive the port above for one window: starts what `plan` asks, records every
 * outcome. The caller re-runs it when the window changes (a `FlatList`
 * `onViewableItemsChanged`) and aborts the controller on unmount.
 *
 * Each outcome is applied to the LATEST state, never to the one `plan` returned:
 * with up to `MAX_IN_FLIGHT` requests open, two answers land in the same tick,
 * and the second must not overwrite the first's thumbnail (found by this
 * module's own test).
 */
export function drive(
  state: ThumbnailState,
  source: ThumbnailSource,
  rows: readonly { readonly kind: string }[],
  first: number,
  last: number,
  controller: AbortSignal,
  onChange: (next: ThumbnailState) => void,
): void {
  const step = plan(state, rows, first, last, controller);
  let current = step.state;
  onChange(current);
  const settle = (next: ThumbnailState): void => {
    current = next;
    onChange(current);
  };
  for (const request of step.start) {
    void source.fetch(request.ref, request.signal).then(
      (thumb) => {
        settle(thumb === null ? failed(current, request.ref.id) : loaded(current, thumb));
      },
      () => {
        settle(failed(current, request.ref.id));
      },
    );
  }
}
