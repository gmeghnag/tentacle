/**
 * The session controller (docs/feat/mobile-session-view.md 12a.3): open attaches
 * and never creates, leave DETACHES (never `close()`, which ends the session —
 * Hazard 3), a fast back-then-forward is serialised per id, and a failed open is
 * a typed reason decided by error class/code, never by message text.
 *
 * A fake `SessionHandle` is the seam: nothing here needs a daemon (the
 * end-to-end proof is `session-link.test.ts`).
 */
import { describe, expect, test } from "bun:test";
import { AttachTimeoutError, type SessionActivity } from "@tentacle/client";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import {
  type SessionHandle,
  createSessionController,
  openFailureReason,
} from "../src/session-controller.ts";

/**
 * A handle whose open/detach the test settles, recording the order of calls.
 * Settling BEFORE the call is reached is honoured too (the controller reaches
 * it a microtask later, so tests do not have to race it).
 */
function fakeHandle(log: string[], id: string) {
  let openAnswer: { readonly error?: unknown } | null = null;
  let detachAnswer = false;
  let openSettle: ((error?: unknown) => void) | null = null;
  let detachSettle: ((error?: unknown) => void) | null = null;
  // The client's contract (`RemoteSession.watch`): what the attach raised with
  // no watcher is delivered to the FIRST one, once.
  const buffered = [{ kind: "history", messages: [] } as unknown as SessionActivity];
  const state = { opened: false, detached: false, watched: 0 };
  const handle = {
    get opened(): boolean {
      return state.opened;
    },
    get detached(): boolean {
      return state.detached;
    },
    get watched(): number {
      return state.watched;
    },
    open(): Promise<void> {
      log.push(`open:${id}`);
      if (openAnswer !== null) {
        if (openAnswer.error !== undefined) {
          return Promise.reject(openAnswer.error);
        }
        state.opened = true;
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        openSettle = (error?: unknown) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          state.opened = true;
          resolve();
        };
      });
    },
    detach(): Promise<void> {
      log.push(`detach:${id}`);
      state.detached = true;
      if (detachAnswer) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve, reject) => {
        detachSettle = (error?: unknown) => {
          if (error !== undefined) {
            reject(error);
            return;
          }
          resolve();
        };
      });
    },
    watch(listener: (activity: SessionActivity) => void): () => void {
      state.watched += 1;
      for (const activity of buffered.splice(0)) {
        listener(activity);
      }
      return () => {
        state.watched -= 1;
      };
    },
  } satisfies SessionHandle & { opened: boolean; detached: boolean; watched: number };
  return {
    handle,
    settleOpen() {
      openAnswer = {};
      openSettle?.();
    },
    failOpen(error: unknown) {
      openAnswer = { error };
      openSettle?.(error);
    },
    settleDetach() {
      detachAnswer = true;
      detachSettle?.();
    },
    failDetach(error: unknown) {
      detachSettle?.(error);
    },
  };
}

type Fake = ReturnType<typeof fakeHandle>;

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("createSessionController", () => {
  test("open attaches, subscribes once, and registers the handle (never a create)", async () => {
    const log: string[] = [];
    const fake = fakeHandle(log, "s1");
    const built: string[] = [];
    const controller = createSessionController({
      newSession: (id, options) => {
        built.push(`${id}${options.reopen === true ? ":reopen" : ""}`);
        return fake.handle;
      },
    });
    const opening = controller.open("s1", { watch: () => {} });
    await flush();
    fake.settleOpen();
    const result = await opening;
    expect(result.ok).toBe(true);
    expect(built).toEqual(["s1"]);
    expect(fake.handle.watched).toBe(1);
    expect(controller.follows("s1")).toBe(true);
  });

  test("reopen is passed through only when asked", async () => {
    const built: string[] = [];
    const controller = createSessionController({
      newSession: (id, options) => {
        built.push(`${id}${options.reopen === true ? ":reopen" : ""}`);
        const fake = fakeHandle([], id);
        fake.settleOpen();
        return fake.handle;
      },
    });
    await controller.open("s1");
    await controller.open("s2", { reopen: true });
    expect(built).toEqual(["s1", "s2:reopen"]);
  });

  test("leave calls detach, NEVER close (mutation: close() instead → red)", async () => {
    const log: string[] = [];
    const fake = fakeHandle(log, "s1");
    const controller = createSessionController({ newSession: () => fake.handle });
    const watch = () => {};
    const opening = controller.open("s1", { watch });
    await flush();
    fake.settleOpen();
    await opening;
    const leaving = controller.leave("s1", watch);
    await flush();
    expect(fake.handle.detached).toBe(true); // `session/detach`, not `session/close`
    expect(fake.handle.watched).toBe(0); // and unsubscribed
    expect(log).toEqual(["open:s1", "detach:s1"]);
    fake.settleDetach();
    await leaving;
    expect(controller.follows("s1")).toBe(false);
  });

  test("an open issued while the same id's detach is in flight AWAITS it (mutation: drop the serialisation → red)", async () => {
    const log: string[] = [];
    const fakes: Fake[] = [fakeHandle(log, "s1"), fakeHandle(log, "s1")];
    let next = 0;
    const controller = createSessionController({
      newSession: () => {
        const fake = fakes[next++] as Fake;
        return fake.handle;
      },
    });
    const opening = controller.open("s1");
    await flush();
    (fakes[0] as Fake).settleOpen();
    await opening;
    const leaving = controller.leave("s1");
    // Back-then-forward fast: the re-open must not reach the client until the
    // detach is settled (the client's session table is keyed by id).
    const reopening = controller.open("s1");
    await flush();
    expect(log).toEqual(["open:s1", "detach:s1"]); // no second open yet
    expect(next).toBe(1); // nor even built
    (fakes[0] as Fake).settleDetach();
    await leaving;
    await flush();
    expect(log).toEqual(["open:s1", "detach:s1", "open:s1"]);
    (fakes[1] as Fake).settleOpen();
    expect((await reopening).ok).toBe(true);
  });

  test("a repeated open of an id already followed reuses it: one listener, one open", async () => {
    const log: string[] = [];
    const fake = fakeHandle(log, "s1");
    const controller = createSessionController({ newSession: () => fake.handle });
    const first = controller.open("s1");
    await flush();
    fake.settleOpen();
    await first;
    const again = await controller.open("s1");
    expect(again.ok).toBe(true);
    expect(log).toEqual(["open:s1"]);
    expect(fake.handle.watched).toBe(0); // no watch passed on either call
  });

  test("open answers typed reasons by class/code, never by message text", async () => {
    const reasons = [
      new RpcError(DomainErrorCode.SessionArchived, "archived"),
      new RpcError(DomainErrorCode.SessionDeleted, "deleted"),
      new RpcError(DomainErrorCode.UnknownSession, "gone"),
      new RpcError(DomainErrorCode.TooManySessions, "too many"),
      new AttachTimeoutError(30_000),
      new RpcError(DomainErrorCode.TurnInProgress, "busy"),
      new Error("archived"),
      "not even an error",
    ].map(openFailureReason);
    expect(reasons).toEqual([
      "archived",
      "deleted",
      "gone",
      "too-many",
      "timeout",
      "link",
      "link", // a message that SAYS archived is not an archived session (a pod chooses it)
      "link",
    ]);
  });

  test("an open that fails registers nothing and can be retried", async () => {
    const log: string[] = [];
    const fakes: Fake[] = [fakeHandle(log, "s1"), fakeHandle(log, "s1")];
    let next = 0;
    const controller = createSessionController({
      newSession: () => (fakes[next++] as Fake).handle,
    });
    const first = controller.open("s1");
    await flush();
    (fakes[0] as Fake).failOpen(new RpcError(DomainErrorCode.SessionArchived, "archived"));
    expect(await first).toEqual({ ok: false, reason: "archived" });
    expect(controller.follows("s1")).toBe(false);
    const retry = controller.open("s1", { reopen: true });
    await flush();
    (fakes[1] as Fake).settleOpen();
    expect((await retry).ok).toBe(true);
  });

  test("leave during an in-flight open detaches: the attach registers nothing (mutation: read `live` before serialising → red)", async () => {
    const log: string[] = [];
    const fake = fakeHandle(log, "s1");
    const controller = createSessionController({ newSession: () => fake.handle });
    const watch = () => {};
    const opening = controller.open("s1", { watch });
    await flush(); // the attach is at the daemon (up to 30 s in the app)
    const leaving = controller.leave("s1", watch); // back tapped: the screen unmounts
    fake.settleOpen();
    const result = await opening;
    expect(result).toEqual({ ok: false, reason: "link" }); // nothing to follow
    await leaving;
    expect(fake.handle.watched).toBe(0); // never subscribed at all: no listener into a gone screen
    expect(controller.follows("s1")).toBe(false);
    // It had already reached the daemon, so the session is detached, never closed.
    expect(log).toEqual(["open:s1", "detach:s1"]);
  });

  test("a leave marked during an open does not poison the NEXT open of that id (mutation: never clear the mark → red)", async () => {
    const log: string[] = [];
    const fakes: Fake[] = [fakeHandle(log, "s1"), fakeHandle(log, "s1")];
    let next = 0;
    const controller = createSessionController({
      newSession: () => (fakes[next++] as Fake).handle,
    });
    const watch = () => {};
    const opening = controller.open("s1", { watch });
    await flush();
    const leaving = controller.leave("s1", watch);
    (fakes[0] as Fake).settleOpen();
    await opening;
    await leaving;
    // Tapped again: a fresh open must attach (the mark was per-leave, not sticky).
    const again = controller.open("s1", { watch: () => {} });
    await flush();
    (fakes[1] as Fake).settleOpen();
    expect((await again).ok).toBe(true);
    expect(controller.follows("s1")).toBe(true);
    expect(log).toEqual(["open:s1", "detach:s1", "open:s1"]);
  });

  test("dispose unsubscribes and detaches an attach that lands afterwards", async () => {
    const log: string[] = [];
    const fake = fakeHandle(log, "s1");
    const controller = createSessionController({ newSession: () => fake.handle });
    const opening = controller.open("s1", { watch: () => {} });
    await flush(); // the attach is in flight at the daemon
    controller.dispose();
    fake.settleOpen();
    const result = await opening;
    expect(result).toEqual({ ok: false, reason: "link" });
    expect(fake.handle.watched).toBe(0);
    // It had already reached the daemon: detached, never closed (nothing ended).
    expect(log).toEqual(["open:s1", "detach:s1"]);
  });

  test("dispose before an open was built never dials at all", async () => {
    const log: string[] = [];
    const fake = fakeHandle(log, "s1");
    const controller = createSessionController({ newSession: () => fake.handle });
    const opening = controller.open("s1");
    controller.dispose();
    const result = await opening;
    fake.settleOpen();
    expect(result).toEqual({ ok: false, reason: "link" });
    expect(log).toEqual([]);
  });
});

/**
 * docs/fix/mobile-session-open-empty.md: the attach history is delivered ONCE,
 * so every watched open must end subscribed to a handle that still holds it.
 */
describe("createSessionController: more than one holder of a session", () => {
  /** A controller over `count` fakes, handed out in order; `log` is their calls. */
  function rig(count: number) {
    const log: string[] = [];
    const fakes = Array.from({ length: count }, () => fakeHandle(log, "s1"));
    let next = 0;
    const controller = createSessionController({
      newSession: () => (fakes[next++] as Fake).handle,
    });
    const fake = (i: number) => fakes[i] as Fake;
    return { log, fake, controller };
  }

  /** A watcher that records the activities it was given. */
  function watcher() {
    const seen: SessionActivity[] = [];
    const watch = (activity: SessionActivity) => {
      seen.push(activity);
    };
    return { seen, watch };
  }

  /** A rig whose first open of `s1` (with `watch`, or none) has settled. */
  async function opened(count: number, watch?: (activity: SessionActivity) => void) {
    const r = rig(count);
    const first = r.controller.open("s1", watch === undefined ? {} : { watch });
    await flush();
    r.fake(0).settleOpen();
    await first;
    return r;
  }

  test("T1: a watch on a watcher-less entry receives the buffered history", async () => {
    const { log, fake, controller } = await opened(1);
    const w = watcher();
    const result = await controller.open("s1", { watch: w.watch });
    expect(result.ok).toBe(true);
    expect(w.seen.map((a) => a.kind)).toEqual(["history"]);
    expect(fake(0).handle.watched).toBe(1);
    expect(log).toEqual(["open:s1"]);
  });

  test("T2: a second watcher takes over by re-attach; the first's late leave is a no-op", async () => {
    const one = watcher();
    const two = watcher();
    const { log, fake, controller } = await opened(2, one.watch);
    const second = controller.open("s1", { watch: two.watch });
    await flush();
    expect(fake(0).handle.watched).toBe(0); // unsubscribed at once
    expect(log).toEqual(["open:s1", "detach:s1"]); // the open waits for the detach
    fake(0).settleDetach();
    await flush();
    fake(1).settleOpen();
    expect(await second).toEqual({ ok: true, session: fake(1).handle });
    expect(two.seen.map((a) => a.kind)).toEqual(["history"]);
    expect(fake(1).handle.watched).toBe(1);
    await controller.leave("s1", one.watch);
    expect(log).toEqual(["open:s1", "detach:s1", "open:s1"]);
    expect(controller.follows("s1")).toBe(true);
    expect(fake(1).handle.watched).toBe(1);
  });

  test("a second watched open queued behind the first's attach takes over too", async () => {
    const { log, fake, controller } = rig(2);
    const one = watcher();
    const two = watcher();
    const first = controller.open("s1", { watch: one.watch });
    const second = controller.open("s1", { watch: two.watch });
    await flush();
    fake(0).settleOpen();
    await first;
    await flush();
    fake(0).settleDetach();
    await flush();
    fake(1).settleOpen();
    expect(await second).toEqual({ ok: true, session: fake(1).handle });
    expect(two.seen.map((a) => a.kind)).toEqual(["history"]);
    expect(fake(0).handle.watched).toBe(0);
    expect(log).toEqual(["open:s1", "detach:s1", "open:s1"]);
  });

  test("a takeover whose detach fails still opens, and a failed open is typed", async () => {
    const one = watcher();
    const { log, fake, controller } = await opened(2, one.watch);
    const second = controller.open("s1", { watch: () => {} });
    await flush();
    fake(0).failDetach(new Error("link down"));
    await flush();
    fake(1).failOpen(new AttachTimeoutError(30_000));
    expect(await second).toEqual({ ok: false, reason: "timeout" });
    expect(controller.follows("s1")).toBe(false);
    expect(log).toEqual(["open:s1", "detach:s1", "open:s1"]);
  });

  test("T3: a watched leave of a held entry only unsubscribes; the holder's leave detaches once", async () => {
    const { log, fake, controller } = await opened(1);
    fake(0).settleDetach();
    const w = watcher();
    await controller.open("s1", { watch: w.watch });
    await controller.leave("s1", w.watch);
    expect(fake(0).handle.watched).toBe(0);
    expect(controller.follows("s1")).toBe(true);
    expect(log).toEqual(["open:s1"]);
    await controller.leave("s1");
    expect(log).toEqual(["open:s1", "detach:s1"]);
    expect(controller.follows("s1")).toBe(false);
  });

  test("T3: the holder's leave keeps a watched entry; the watcher's leave then detaches once", async () => {
    const { log, fake, controller } = await opened(1);
    fake(0).settleDetach();
    const w = watcher();
    await controller.open("s1", { watch: w.watch });
    await controller.leave("s1");
    expect(fake(0).handle.watched).toBe(1);
    expect(controller.follows("s1")).toBe(true);
    expect(log).toEqual(["open:s1"]);
    await controller.leave("s1", w.watch);
    expect(log).toEqual(["open:s1", "detach:s1"]);
    expect(controller.follows("s1")).toBe(false);
  });

  test("a watcher that never got the entry cannot release it", async () => {
    const { log, fake, controller } = await opened(1);
    fake(0).settleDetach(); // a wrong detach fails the assertion, never hangs
    await controller.leave("s1", () => {});
    expect(controller.follows("s1")).toBe(true);
    expect(log).toEqual(["open:s1"]);
  });

  test("a held entry whose history was already delivered is re-attached, never reused empty", async () => {
    const { log, fake, controller } = await opened(2);
    const one = watcher();
    fake(0).settleDetach();
    await controller.open("s1", { watch: one.watch });
    await controller.leave("s1", one.watch);
    // The SAME watcher again (a screen's resync): it needs the history anew.
    const again = controller.open("s1", { watch: one.watch });
    await flush();
    fake(1).settleOpen();
    expect(await again).toEqual({ ok: true, session: fake(1).handle });
    expect(one.seen.map((a) => a.kind)).toEqual(["history", "history"]);
    expect(log).toEqual(["open:s1", "detach:s1", "open:s1"]);
    // The hold survives the re-attach: the screen leaving keeps the entry.
    await controller.leave("s1", one.watch);
    expect(controller.follows("s1")).toBe(true);
    expect(log).toEqual(["open:s1", "detach:s1", "open:s1"]);
  });

  test("the holder leaving DURING a takeover releases the hold without cancelling the open", async () => {
    const { log, fake, controller } = await opened(2);
    const one = watcher();
    const two = watcher();
    await controller.open("s1", { watch: one.watch });
    const second = controller.open("s1", { watch: two.watch });
    await flush();
    const holder = controller.leave("s1"); // the workflow screen goes away
    fake(0).settleDetach();
    await flush();
    fake(1).settleOpen();
    expect((await second).ok).toBe(true);
    await holder;
    expect(controller.follows("s1")).toBe(true);
    fake(1).settleDetach();
    await controller.leave("s1", two.watch);
    expect(controller.follows("s1")).toBe(false); // no hold left behind
    expect(log).toEqual(["open:s1", "detach:s1", "open:s1", "detach:s1"]);
  });

  test("T4: the superseded screen's leave during the takeover's attach cancels nothing", async () => {
    const one = watcher();
    const two = watcher();
    const { log, fake, controller } = await opened(2, one.watch);
    const second = controller.open("s1", { watch: two.watch });
    await flush();
    fake(0).settleDetach();
    await flush(); // the fresh attach is at the daemon
    const late = controller.leave("s1", one.watch);
    fake(1).settleOpen();
    expect((await second).ok).toBe(true);
    await late;
    expect(controller.follows("s1")).toBe(true);
    expect(fake(1).handle.watched).toBe(1);
    expect(log).toEqual(["open:s1", "detach:s1", "open:s1"]);
  });

  test("a screen that left while queued behind another holder's attach is never subscribed", async () => {
    const { fake, controller } = rig(1);
    const w = watcher();
    const holder = controller.open("s1");
    const screen = controller.open("s1", { watch: w.watch });
    await flush();
    const leaving = controller.leave("s1", w.watch);
    fake(0).settleOpen();
    expect((await holder).ok).toBe(true);
    expect(await screen).toEqual({ ok: false, reason: "link" });
    await leaving;
    expect(w.seen).toEqual([]);
    expect(fake(0).handle.watched).toBe(0);
    expect(controller.follows("s1")).toBe(true);
  });

  test("an anonymous leave still cancels an anonymous open in flight", async () => {
    const { log, fake, controller } = rig(1);
    const holder = controller.open("s1");
    await flush();
    const leaving = controller.leave("s1");
    fake(0).settleOpen();
    expect(await holder).toEqual({ ok: false, reason: "link" });
    await leaving;
    expect(controller.follows("s1")).toBe(false);
    expect(log).toEqual(["open:s1", "detach:s1"]);
  });
});
