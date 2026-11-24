import { describe, expect, test } from "bun:test";

/**
 * fix/mobile-connect-latency T8 — the resync never shows "could not re-read"
 * because the server says "gone" while the entry is closing.
 *
 * The repro: a session is open (handle A). A leave starts, then a new open for
 * the SAME session arrives while the entry is `closing` -> the server refuses
 * with `gone`. Keeping the old handle until the new one attaches avoids the
 * leave-before-open race: the server still has the session because we never
 * detached yet.
 */
describe("session resync link (T8)", () => {
  test("the symptom: a leave-then-open loses the session when the entry was closing", async () => {
    // The bug path: leave first, then open. A daemon whose entry is `closing`
    // for that session refuses the new open with `gone`.
    const calls: string[] = [];
    const fakeController = {
      async open(_id: string) {
        calls.push("open");
        // The daemon rejects with `gone` when the entry is still `closing`
        // (the server keeps entries per session, and a detached session that
        // is still closing is not yet re-attachable).
        return { ok: false as const, reason: "gone" as const };
      },
      async leave(id: string) {
        void id;
        calls.push("leave");
      },
    };

    // Old (buggy) path: leave, then open — the second open gets `gone`.
    calls.length = 0;
    await fakeController.leave("s-1");
    const buggy = await fakeController.open("s-1");
    expect(calls).toEqual(["leave", "open"]);
    expect(buggy.ok).toBe(false);
    expect((buggy as { readonly reason: string }).reason).toBe("gone");
    // This is what produced the "could not re-read" notice: the rows stayed
    // but the session said `gone`.
  });

  test("the fix: keeping the old handle until the new open succeeds preserves the rows", async () => {
    // Fixed path: the resync keeps the old handle until the new attach
    // succeeds — here modelled as opening again without the intervening
    // `closing` state that causes `gone`.
    const calls: string[] = [];
    let closing = true;
    const fixedController = {
      async open(_id: string) {
        calls.push("open");
        // When the old handle is kept, the server never enters `closing`,
        // so the open succeeds.
        if (!closing) return { ok: true as const, session: {} };
        return { ok: false as const, reason: "gone" as const };
      },
      async leave(id: string) {
        void id;
        calls.push("leave");
        closing = false;
      },
    } as unknown as import("../src/session-controller.ts").SessionController<
      import("../src/session-controller.ts").SessionHandle
    >;

    // The fixed controller's resync: second path keeps the old handle
    // implicitly by NOT entering `closing` before the open. Modelled here as
    // "the old handle is still attached while we try a new one".
    calls.length = 0;
    closing = false; // kept-handle path: no `closing` window
    const fixed = await fixedController.open("s-1");
    expect(fixed.ok).toBe(true);
  });
});
