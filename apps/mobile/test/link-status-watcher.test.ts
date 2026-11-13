/**
 * The list's link-status subscription (docs/feat/mobile-app-shell.md): it must
 * follow whichever client is CURRENT, because a failed dial is forgotten by the
 * registry and Retry hands back a NEW client (review round 1 finding 4).
 */
import { describe, expect, test } from "bun:test";
import type { LinkStatus } from "@tentacle/client";
import { createLinkStatusWatcher } from "../src/link-status-watcher.ts";

const UP: LinkStatus = { state: "up" };
const DOWN: LinkStatus = { state: "reconnecting", attempt: 1, nextAtMs: 0 };

/** A client whose status the test raises by hand, counting subscriptions. */
function fakeClient(name: string) {
  const listeners = new Set<(status: LinkStatus) => void>();
  return {
    name,
    subscriptions: 0,
    unsubscribed: 0,
    onStatus(listener: (status: LinkStatus) => void): () => void {
      this.subscriptions += 1;
      listeners.add(listener);
      return () => {
        this.unsubscribed += 1;
        listeners.delete(listener);
      };
    },
    emit(status: LinkStatus): void {
      for (const listener of listeners) {
        listener(status);
      }
    },
    get live(): number {
      return listeners.size;
    },
  };
}

describe("createLinkStatusWatcher", () => {
  test("a status change on the watched link reaches the listener", () => {
    const seen: boolean[] = [];
    const watcher = createLinkStatusWatcher<ReturnType<typeof fakeClient>>((up) => seen.push(up));
    const a = fakeClient("a");
    watcher.watch(a);
    a.emit(DOWN);
    a.emit(UP);
    expect(seen).toEqual([false, true]);
  });

  test("watching the same link twice does not double-subscribe", () => {
    const seen: boolean[] = [];
    const watcher = createLinkStatusWatcher<ReturnType<typeof fakeClient>>((up) => seen.push(up));
    const a = fakeClient("a");
    watcher.watch(a);
    watcher.watch(a);
    a.emit(DOWN);
    expect(seen).toEqual([false]);
    expect(a.subscriptions).toBe(1);
  });

  test("a NEW link replaces the old subscription (a retry dials a new client)", () => {
    // The registry forgets a failed dial, so Retry's `open` produces client B.
    // A subscription made once at mount would then listen to dead client A:
    // later drops would not mark the list stale and its recovery would not
    // refresh (review round 1 finding 4).
    const seen: boolean[] = [];
    const watcher = createLinkStatusWatcher<ReturnType<typeof fakeClient>>((up) => seen.push(up));
    const a = fakeClient("a");
    watcher.watch(a);
    const b = fakeClient("b");
    watcher.watch(b);
    expect(a.unsubscribed).toBe(1); // the old one is gone, not leaked
    expect(a.live).toBe(0);
    a.emit(DOWN); // must NOT reach the list any more
    b.emit(DOWN);
    b.emit(UP);
    expect(seen).toEqual([false, true]);
  });

  test("stop() removes the subscription; a later watch starts again", () => {
    const seen: boolean[] = [];
    const watcher = createLinkStatusWatcher<ReturnType<typeof fakeClient>>((up) => seen.push(up));
    const a = fakeClient("a");
    watcher.watch(a);
    watcher.stop();
    expect(a.live).toBe(0);
    a.emit(DOWN);
    expect(seen).toEqual([]);
    const b = fakeClient("b");
    watcher.watch(b);
    b.emit(UP);
    expect(seen).toEqual([true]);
  });
});
