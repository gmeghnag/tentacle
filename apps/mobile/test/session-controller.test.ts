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
import { AttachTimeoutError } from "@tentacle/client";
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
  let detachSettle: (() => void) | null = null;
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
      return new Promise<void>((resolve) => {
        detachSettle = resolve;
      });
    },
    watch(): () => void {
      state.watched += 1;
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
    const opening = controller.open("s1", { watch: () => {} });
    await flush();
    fake.settleOpen();
    await opening;
    const leaving = controller.leave("s1");
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
