/**
 * Drafts over 13b's store (docs/feat/mobile-compose.md 13d, D4): the per-session
 * field text and photo copies, written debounced (13b's `createDraftScheduler`
 * policy) and forced on the acts nobody can undo (leaving, backgrounding, an item
 * created from the field, a hand-back).
 *
 * Pure of React and of Expo: the timer is injected (`schedule`), so the debounce
 * is tested without a clock, and the file is 13b's (`OutboxStore.setDrafts`), so
 * one computer has one atomic file.
 */
import {
  type DraftContent,
  type DraftKey,
  type DraftScheduler,
  contentOf,
  createDraftScheduler,
  draftKey,
  draftOf,
} from "./drafts.ts";
import type { OutboxStore } from "./outbox-store.ts";

/** A timer seam (the app passes `setTimeout`; a test fires it by hand). */
export interface Timer {
  schedule(fn: () => void, ms: number): { readonly cancel: () => void };
}

export interface DraftStore {
  /** What was left in this session's field, or empty. */
  read(computerId: string, sessionId: string): DraftContent;
  /** A keystroke (debounced). */
  touch(computerId: string, sessionId: string, content: DraftContent): void;
  /** Write it NOW (leaving, backgrounding, an item created, a hand-back). */
  force(computerId: string, sessionId: string, content: DraftContent): void;
  /** Write everything pending now (the app going to the background). */
  flush(): Promise<void>;
  /** Drop the pending work (the store is closing). */
  clear(): void;
}

export function createDraftStore(
  store: OutboxStore,
  now: () => number,
  timer: Timer,
  debounceMs?: number,
): DraftStore {
  const scheduler: DraftScheduler =
    debounceMs === undefined ? createDraftScheduler(now) : createDraftScheduler(now, debounceMs);
  let armed: { readonly cancel: () => void } | null = null;

  /** Write what is due into the file (one write for everything pending). */
  const write = async (): Promise<void> => {
    const pending = scheduler.take();
    if (pending.length === 0) {
      return;
    }
    let drafts = [...store.data.drafts];
    for (const entry of pending) {
      const [computerId, sessionId] = entry.key;
      const draft = draftOf(entry.key, entry.content, now());
      drafts = drafts.filter(
        (kept) => kept.computerId !== computerId || kept.sessionId !== sessionId,
      );
      if (draft !== null) {
        drafts.push(draft);
      }
    }
    await store.setDrafts(drafts);
  };

  /** Consume the scheduler's due time and arm ONE timer for the whole store. */
  const arm = (): void => {
    armed?.cancel();
    armed = null;
    const due = scheduler.dueIn(now());
    if (due === null) {
      return;
    }
    armed = timer.schedule(() => {
      armed = null;
      void write().then(arm);
    }, due);
  };

  return {
    read(computerId, sessionId) {
      const key = draftKey(computerId, sessionId);
      const found = store.data.drafts.find(
        (draft) => draftKey(draft.computerId, draft.sessionId) === key,
      );
      return found === undefined ? { text: "", photos: [] } : contentOf(found);
    },
    touch(computerId, sessionId, content) {
      scheduler.touch([computerId, sessionId] as DraftKey, content);
      arm();
    },
    force(computerId, sessionId, content) {
      scheduler.force([computerId, sessionId] as DraftKey, content);
      void write().then(arm);
    },
    async flush() {
      armed?.cancel();
      armed = null;
      await write();
    },
    clear() {
      armed?.cancel();
      armed = null;
      scheduler.clear();
    },
  };
}
