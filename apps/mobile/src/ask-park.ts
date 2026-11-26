/**
 * The parked ask (docs/fix/mobile-ask-surfaces.md D3): a swipe-down PARKS an ask,
 * it never withdraws it. Pure and React-free (AGENTS §7). Three small rules:
 *
 * - `ASK_PARKS` remembers which asks the person parked, keyed
 *   `computerId/sessionId/requestId`, so a re-delivered ask (a detach and
 *   re-attach, a session switch, the lock drain's `idle → asking`) comes back
 *   parked, never as a surprise sheet. `forget` when answered here (the sheet's
 *   `onSettled`), never on a withdrawal: the replay needs the note.
 * - `askBanner` is what the parked ask shows under the header;
 *   `landingAskBanner` is the Workflows landing's (any ask not up there).
 * - `askPresented` / `askSurface` decide whether the sheet is up and which form
 *   it draws (the peek detent never draws buttons).
 */
import type { AskOrigin } from "@tentacle/client";
import { originWords } from "@tentacle/client";
import type { SheetState } from "./permission-sheet.ts";

/** What one parked ask is stored under: its own id, so a new ask never inherits it. */
export function parkKey(computerId: string, sessionId: string, requestId: string): string {
  return `${computerId}\u0000${sessionId}\u0000${requestId}`;
}

export interface AskParks {
  /** The person parked this ask. */
  note(key: string): void;
  /** Was it parked (a re-delivery opens parked)? */
  has(key: string): boolean;
  /** The ask was answered here, or the banner brought it back. Never on a withdrawal. */
  forget(key: string): void;
}

/**
 * How many notes are kept. A note is spent when the ask is answered HERE; one
 * answered on another device (a withdrawal, like a detach) keeps its note, inert
 * because a settled id is never re-delivered. The cap bounds those leftovers.
 */
export const ASK_PARKS_CAP = 256;

export function createAskParks(cap = ASK_PARKS_CAP): AskParks {
  const parked = new Set<string>(); // insertion order = age
  return {
    note: (key) => {
      parked.delete(key);
      parked.add(key);
      for (const oldest of parked) {
        if (parked.size <= cap) {
          break;
        }
        parked.delete(oldest);
      }
    },
    has: (key) => parked.has(key),
    forget: (key) => {
      parked.delete(key);
    },
  };
}

/** The app's ONE parked memory, held outside React like `SHEET_DETENTS`. */
export const ASK_PARKS: AskParks = createAskParks();

export interface AskBannerView {
  readonly title: string;
  /** The origin's lead (`Main agent`, `Sub-agent explore`, the workflow's name). */
  readonly originShort: string;
  /** Asks queued behind this one (the «+1»); 0 = none. */
  readonly more: number;
}

/**
 * The banner under the header: only while an ask is on screen AND parked.
 * `queued` = asks waiting behind the shown one.
 */
export function askBanner(
  state: SheetState,
  queued: number,
  origin: AskOrigin,
): AskBannerView | null {
  if (state.kind !== "asking" || !state.parked) {
    return null;
  }
  return bannerOf(state.request.title, queued, origin);
}

function bannerOf(title: string, queued: number, origin: AskOrigin): AskBannerView {
  return {
    title,
    originShort: originWords(origin).lead,
    more: Math.max(0, Math.floor(queued)),
  };
}

/**
 * The banner the Workflows LANDING shows (docs/fix/mobile-workflows-landing-v2.md
 * D1): an ask that is not presented there — parked, or never brought up
 * (`!reviewed`, `askPresentable`'s rule over the landing). Null when idle,
 * returned, or the sheet is up.
 */
export function landingAskBanner(
  state: SheetState,
  queued: number,
  origin: AskOrigin,
): AskBannerView | null {
  if (state.kind !== "asking" || (!state.parked && state.reviewed)) {
    return null;
  }
  return bannerOf(state.request.title, queued, origin);
}

export interface AskPresentedInput {
  readonly asking: boolean;
  readonly parked: boolean;
  readonly drawerOpen: boolean;
  /** The screen in front may present it (S8 narrows this for a run screen). */
  readonly presentable: boolean;
}

/** What `desiredStack` gets as `permission`. */
export function askPresented(input: AskPresentedInput): boolean {
  return input.asking && !input.parked && !input.drawerOpen && input.presentable;
}

/** The peek detent (index 0) draws the one-row form — never buttons. */
export function askSurface(detentIndex: number): "slim" | "card" {
  return detentIndex <= 0 ? "slim" : "card";
}

export interface AskDetentFeed {
  /** The detent index the ask's sheet is at (0 = peek). */
  get(): number;
  set(index: number): void;
  subscribe(listener: () => void): () => void;
}

/** The sheet's content learns its detent here (`sheetDetentChange` → `askSurface`). */
export function createAskDetentFeed(initial = 1): AskDetentFeed {
  let index = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => index,
    set: (next) => {
      if (next === index) {
        return;
      }
      index = next;
      for (const l of [...listeners]) {
        l();
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const ASK_DETENT: AskDetentFeed = createAskDetentFeed();
