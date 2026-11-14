/**
 * Per-session drafts (docs/feat/mobile-compose.md 13b, D4): the field text and
 * photo chips the person left behind, so opening the session again (or
 * relaunching after a kill) finds what they wrote.
 *
 * Pure: the clock is injected, so the debounce policy is tested without a
 * timer, a simulator or a React effect. A `DraftStore` (the caller) persists.
 *
 * Rules this module owns:
 * - **Drafts are per `(computerId, sessionId)`.** The same session id on two
 *   computers is two conversations, so it is two drafts.
 * - **Saving is DEBOUNCED** (`DRAFT_DEBOUNCE_MS` after the last keystroke), and
 *   a flush is FORCED on the events the person cannot undo: leaving the screen,
 *   the app going to the background, and an item created from the field (its
 *   text must be on disk before the outbox item is).
 * - **An empty draft is deleted, not saved** — except one that still has photo
 *   chips (the text may be cleared while a photo stays), and except the one
 *   `keep` marks: a cleared field after a restoration is a real state, and
 *   writing it back on open would resurrect the text the person just cleared.
 */

/** How long after the last keystroke the draft is written (decision 16: survives a kill). */
export const DRAFT_DEBOUNCE_MS = 400;

/** One session's draft, as it is persisted. */
export interface Draft {
  readonly computerId: string;
  readonly sessionId: string;
  readonly text: string;
  /** Chip file paths (13c's copies); they outlive the screen, so they are part of the draft. */
  readonly photos: readonly string[];
  /** The last write's stamp (ms since epoch, the injected clock). */
  readonly savedAt: number;
}

/** What the screen shows and edits: `Draft` without the stamps. */
export interface DraftContent {
  readonly text: string;
  readonly photos: readonly string[];
}

export type DraftKey = readonly [computerId: string, sessionId: string];

/** The stable key of a draft (`(computerId, sessionId)`, never a joined string). */
export const draftKey = (computerId: string, sessionId: string): string =>
  JSON.stringify([computerId, sessionId]);

/** Nothing to remember: no text and no chips. */
export const isEmptyDraft = (content: DraftContent): boolean =>
  content.text === "" && content.photos.length === 0;

/**
 * The debounce state machine: which write is due, and when. One instance per
 * store; `touch` is a keystroke, `flush` forces the pending write now.
 *
 * `onDue` is called by the caller's own timer with `take()`.
 */
export interface DraftScheduler {
  /** A change: remember it and arm (or re-arm) the debounce. */
  touch(key: DraftKey, content: DraftContent): void;
  /** What is pending, before its deadline (the app backgrounded / the screen left). */
  take(): readonly { readonly key: DraftKey; readonly content: DraftContent }[];
  /** A change nobody can undo (a field cleared after a restore, an item created): write it now. */
  force(key: DraftKey, content: DraftContent): void;
  /** The next deadline in ms from `now`, or null when nothing is pending. */
  dueIn(now: number): number | null;
  /** Forget everything pending (a closed store; the app is gone). */
  clear(): void;
}

export function createDraftScheduler(
  now: () => number,
  debounceMs = DRAFT_DEBOUNCE_MS,
): DraftScheduler {
  const pending = new Map<string, { key: DraftKey; content: DraftContent; at: number }>();

  const record = (key: DraftKey, content: DraftContent): void => {
    pending.set(draftKey(key[0], key[1]), { key, content, at: now() });
  };

  return {
    touch(key, content) {
      record(key, content);
    },
    take() {
      const out = [...pending.values()].map(({ key, content }) => ({ key, content }));
      pending.clear();
      return out;
    },
    force(key, content) {
      // Marked due at once: `take()` hands it over like any other, and a later
      // `touch` of the same key re-arms the debounce for the NEWER content.
      pending.set(draftKey(key[0], key[1]), { key, content, at: now() - debounceMs });
    },
    dueIn(at) {
      let soonest: number | null = null;
      for (const entry of pending.values()) {
        const left = Math.max(0, entry.at + debounceMs - at);
        soonest = soonest === null ? left : Math.min(soonest, left);
      }
      return soonest;
    },
    clear() {
      pending.clear();
    },
  };
}

/**
 * The draft as the store keeps it, or null when there is nothing to keep.
 *
 * `photos` are kept even with no text: a chip the person added is work. An
 * empty draft is removed by the store (`null`), which is how "the field is
 * clear" is remembered for a session whose draft was restored.
 */
export function draftOf(key: DraftKey, content: DraftContent, savedAt: number): Draft | null {
  if (isEmptyDraft(content)) {
    return null;
  }
  return {
    computerId: key[0],
    sessionId: key[1],
    text: content.text,
    photos: [...content.photos],
    savedAt,
  };
}

/** The content of a stored draft, for the field (a newer build's extra fields are ignored). */
export const contentOf = (draft: Draft): DraftContent => ({
  text: draft.text,
  photos: [...draft.photos],
});
