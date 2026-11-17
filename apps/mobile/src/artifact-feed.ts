import type { ArtifactMeta } from "@tentacle/protocol";
/**
 * The live artifact list, published by the session screen and read by the
 * gallery (docs/feat/model-artifacts.md D9).
 *
 * Why a registry instead of a second client: a second `RemoteSession` of one id
 * STEALS the open session's stream (`App.tsx`'s compose half comment), so the
 * gallery screen may never dial. The screen that owns the one handle publishes
 * what its `artifact/list` answered here, and the gallery — a sibling screen —
 * reads it. Same shape as the app's `LINKS`/`RECORDS` idiom: a module-level
 * registry, keyed, with a `forget` for the flows that end a pairing.
 *
 * Pure (no React, no client import): the phase words are `artifact-join.ts`'s.
 */
import type { ArtifactPhase } from "./artifact-join.ts";

/**
 * The reader a gallery row opens with: the OWNING screen's own `readArtifact`
 * (a second `RemoteSession` of one id steals the stream), so it is published on
 * the feed the same way the list is.
 */
export type FeedReader = (
  meta: ArtifactMeta,
  options?: { readonly signal?: AbortSignal },
) => Promise<Uint8Array>;

/** What the screen last knew: the list and the phase it is in. */
export interface ArtifactSnapshot {
  readonly list: readonly ArtifactMeta[];
  readonly phase: ArtifactPhase;
}

export const EMPTY_SNAPSHOT: ArtifactSnapshot = { list: [], phase: "loading" };

export interface ArtifactFeed {
  current(): ArtifactSnapshot;
  publish(next: ArtifactSnapshot): void;
  subscribe(listener: (snapshot: ArtifactSnapshot) => void): () => void;
  /**
   * A reader wants fresh bytes (the gallery mounted, a pull-to-refresh): the
   * OWNER of the handle re-asks `artifact/list`. The gallery cannot ask itself —
   * it holds no handle.
   */
  requestRefresh(): void;
  onRefresh(listener: () => void): () => void;
  /**
   * The handle's own verified read, published by the screen that holds it (once,
   * at attach: the closure reads the CURRENT handle, so its identity is stable
   * and a viewer opened on it never re-reads on an unrelated publish).
   */
  provideRead(reader: FeedReader): void;
  /** That reader, or `undefined` before a screen attached to this session. */
  read(): FeedReader | undefined;
}

export function feedKey(computerId: string, sessionId: string): string {
  return `${computerId}/${sessionId}`;
}

export interface FeedRegistry {
  /** This session's feed, created on first ask (a gallery opened first still works). */
  feed(computerId: string, sessionId: string): ArtifactFeed;
  /** The pairing or the session is gone: drop its feed and its listeners. */
  forget(computerId: string, sessionId: string): void;
}

export function createFeedRegistry(): FeedRegistry {
  const feeds = new Map<string, ArtifactFeed>();
  const make = (): ArtifactFeed => {
    let snapshot: ArtifactSnapshot = EMPTY_SNAPSHOT;
    let reader: FeedReader | undefined;
    const listeners = new Set<(snapshot: ArtifactSnapshot) => void>();
    const refreshListeners = new Set<() => void>();
    return {
      current: () => snapshot,
      publish(next) {
        snapshot = next;
        for (const listener of listeners) {
          listener(next);
        }
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      requestRefresh() {
        for (const listener of refreshListeners) {
          listener();
        }
      },
      onRefresh(listener) {
        refreshListeners.add(listener);
        return () => refreshListeners.delete(listener);
      },
      provideRead(next) {
        reader = next;
      },
      read() {
        return reader;
      },
    };
  };
  return {
    feed(computerId, sessionId) {
      const key = feedKey(computerId, sessionId);
      const held = feeds.get(key);
      if (held !== undefined) {
        return held;
      }
      const made = make();
      feeds.set(key, made);
      return made;
    },
    forget(computerId, sessionId) {
      feeds.delete(feedKey(computerId, sessionId));
    },
  };
}

/** The app's ONE registry (one feed per computer/session, for the app's lifetime). */
export const ARTIFACT_FEEDS: FeedRegistry = createFeedRegistry();
