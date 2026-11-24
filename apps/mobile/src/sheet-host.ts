/**
 * The native sheets' CONTENT bridge (docs/feat/mobile-native-sheets.md D2), pure
 * and React-free: a native sheet is a stack ROUTE, so it cannot be handed the
 * session screen's state as props — the screen publishes the SAME element it used
 * to render inside a `<Modal>`, and the route reads it back.
 *
 * Why a registry instead of a second session handle: this is `artifact-feed.ts`'s
 * shape and reason (`App.tsx`'s compose half comment) — the sibling route may
 * never dial, so the screen that owns the one handle publishes what it draws. One
 * host per computer/session, keyed, with a `forget` for the flows that end it.
 *
 * Three rules the route depends on:
 * - **Nothing published → nothing drawn.** The route renders no empty sheet (an
 *   owner rule): a kind with no content is not on screen yet.
 * - **A forgotten host with nothing published → the route pops itself.** That is
 *   the orphan case (the session screen is gone: a drawer `replace`, a
 *   notification `reset`). A route pushed before the screen's FIRST publish must
 *   wait instead: the push and the publishing layout effect are not ordered
 *   across two screens. A publish revives the host, so a remounted screen keeps
 *   the route that is still up.
 * - **`snapshot` returns a STABLE object** until that kind's content or the
 *   orphan flag changes: it is `getSnapshot` for the route's
 *   `useSyncExternalStore`, and a fresh object per call would re-render forever.
 */
import type { SheetKind } from "./sheet-plan.ts";

/** What a route draws for one kind: the content, and whether its screen is gone. */
export interface SheetSnapshot {
  /** The published element, or `undefined` before the screen's first publish. */
  readonly content: unknown;
  /** The host was forgotten with nothing published since. */
  readonly orphaned: boolean;
}

/** One session's published sheet contents, one entry per kind. */
export interface SheetHost {
  /** What this session last published for `kind`, or `undefined` before any. */
  current(kind: SheetKind): unknown;
  /** The route's `useSyncExternalStore` snapshot: stable across equal states. */
  snapshot(kind: SheetKind): SheetSnapshot;
  /** The screen's layout effect: replace one kind's content (never appends). */
  publish(kind: SheetKind, content: unknown): void;
  /** A listener per route; returns the unsubscribe. */
  subscribe(listener: () => void): () => void;
  /**
   * The session screen is gone: empty every kind and mark the host ORPHANED, so
   * a route still up pops itself instead of drawing an empty sheet.
   */
  forget(): void;
  /** Whether the host was forgotten with nothing published since (the orphan pop). */
  orphaned(): boolean;
}

/** What the route may do with its snapshot (the ONE branch left in the route). */
export type SheetRouteView = "draw" | "wait" | "pop";

/**
 * The route's one decision: draw the published content; wait for a publish that
 * has not happened yet; or pop, because the screen that publishes is gone.
 */
export function sheetRouteView(snapshot: SheetSnapshot): SheetRouteView {
  if (snapshot.content !== undefined) {
    return "draw";
  }
  return snapshot.orphaned ? "pop" : "wait";
}

export interface SheetHosts {
  /** This session's host, created on first ask (a route pushed first still works). */
  host(computerId: string, sessionId: string): SheetHost;
  /** The pairing or the session is gone: drop its host and its listeners. */
  forget(computerId: string, sessionId: string): void;
}

/** The key one session's host is stored under (a separator no id can contain). */
export function sheetHostKey(computerId: string, sessionId: string): string {
  return `${computerId}\u0000${sessionId}`;
}

export function createSheetHosts(): SheetHosts {
  const hosts = new Map<string, SheetHost>();
  const make = (): SheetHost => {
    const published = new Map<SheetKind, unknown>();
    const snapshots = new Map<SheetKind, SheetSnapshot>();
    const listeners = new Set<() => void>();
    let forgotten = false;
    const notify = () => {
      for (const listener of listeners) {
        listener();
      }
    };
    const snapshot = (kind: SheetKind): SheetSnapshot => {
      const content = published.get(kind);
      const held = snapshots.get(kind);
      if (held !== undefined && held.content === content && held.orphaned === forgotten) {
        return held;
      }
      const next: SheetSnapshot = { content, orphaned: forgotten };
      snapshots.set(kind, next);
      return next;
    };
    return {
      current: (kind) => published.get(kind),
      snapshot,
      publish(kind, content) {
        published.set(kind, content);
        forgotten = false;
        notify();
      },
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      forget() {
        published.clear();
        forgotten = true;
        notify();
      },
      orphaned: () => forgotten,
    };
  };
  return {
    host(computerId, sessionId) {
      const key = sheetHostKey(computerId, sessionId);
      const held = hosts.get(key);
      if (held !== undefined) {
        return held;
      }
      const made = make();
      hosts.set(key, made);
      return made;
    },
    forget(computerId, sessionId) {
      hosts.get(sheetHostKey(computerId, sessionId))?.forget();
      hosts.delete(sheetHostKey(computerId, sessionId));
    },
  };
}

/** The app's ONE registry (one host per computer/session, for the app's lifetime). */
export const SHEET_HOSTS: SheetHosts = createSheetHosts();
