/**
 * docs/feat/session-auto-accept.md T5: the phone's sheet and the session's
 * SHARED auto-accept. Each test names the mutation that turns it red.
 */
import { describe, expect, test } from "bun:test";
import { createAutoAcceptHandle } from "@tentacle/client";
import type { PermissionRequest } from "@tentacle/core";
import { ARM_MS, createPermissionSheet } from "../src/permission-sheet.ts";

function ask(over: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    tool: "fs_write",
    level: "ask",
    title: "Write a file",
    detail: "a.txt",
    input: {},
    ...over,
  };
}

/** A session's link, as the phone's client hands it to the sheet. */
function link(shared: boolean, initial = false) {
  const sent: boolean[] = [];
  const handle = createAutoAcceptHandle({
    shared,
    initial,
    send: (on) => {
      sent.push(on);
      return Promise.resolve({ on });
    },
  });
  if (shared) handle.sync(initial);
  return { link: handle.link, handle, sent };
}

function sheetWith(autoAccept?: ReturnType<typeof link>["link"], armMs?: number) {
  const clock = { at: 1000 };
  const sheet = createPermissionSheet({
    now: () => clock.at,
    ...(armMs === undefined ? {} : { armMs }),
    ...(autoAccept === undefined ? {} : { autoAccept: () => autoAccept }),
  });
  return { sheet, clock };
}

describe("the phone's shared auto-accept", () => {
  test("ON + an eligible ask → answered allow_once at once, never `asking`", async () => {
    // Mutation: ignore the link in the requester → the ask is shown (`asking`).
    const session = link(true, true);
    const { sheet } = sheetWith(session.link);
    const answer = sheet.requester(ask(), { turnId: "t-1" });
    await Promise.resolve();
    expect(await answer).toEqual({ allowed: true, scope: "once" });
    expect(sheet.asking).toBe(false);
    expect(sheet.autoAccepted).toBe("auto-accepted · fs_write");
  });

  test("never allow_always, even though the sheet OFFERS it", async () => {
    const session = link(true, true);
    const { sheet } = sheetWith(session.link);
    const response = await sheet.requester(ask({ suggestion: { prefix: "git" } }), {
      turnId: "t-1",
    });
    expect(response).toEqual({ allowed: true, scope: "once" });
    expect(response.scope).not.toBe("session");
  });

  test("OFF → the ask is shown and arm-guarded, exactly as today", async () => {
    const session = link(true, false);
    const { sheet, clock } = sheetWith(session.link);
    void sheet.requester(ask(), {});
    await Promise.resolve();
    expect(sheet.asking).toBe(true);
    expect(sheet.answer("allow_once")).toBe("ignored");
    clock.at += ARM_MS;
    expect(sheet.answer("allow_once")).toBe("sent");
  });

  test("a hooks_trust / session_hop ask always reaches a person", async () => {
    // Mutation: call `autoApproves` without the kind test → these are answered.
    const session = link(true, true);
    const { sheet, clock } = sheetWith(session.link);
    for (const kind of ["hooks_trust", "session_hop"] as const) {
      const answer = sheet.requester(ask({ kind }), {});
      await Promise.resolve();
      expect(sheet.asking).toBe(true);
      // The age guard holds a TAP, not the test: the clock moves past it.
      expect(sheet.answer("reject_once", clock.at + ARM_MS)).toBe("sent");
      expect(await answer).toEqual({ allowed: false });
    }
  });

  test("a POD session (not shared) never auto-answers, whatever it claimed", async () => {
    // Mutation: default the trust bit to on → the pod's ON answers.
    const pod = link(false, false);
    pod.handle.receive(true, "pod"); // a pod's claim: dropped by the link
    const { sheet } = sheetWith(pod.link);
    void sheet.requester(ask(), {});
    await Promise.resolve();
    expect(sheet.asking).toBe(true);
  });

  test("an ask with NO turn id always reaches a person (the rule every device shares)", async () => {
    // `ownRequest(turnId, owns)` is false for a missing turn id under a session
    // that decides, and the phone's session DOES decide now (its switch is the
    // session's). Mutation: pass `undefined` as the own-turn test → this ask is
    // auto-answered, and the phone grants what a terminal would show
    // (session-auto-accept.md Review round 1, MEDIUM 4; D4 "a request with no
    // turn id stays not mine").
    const session = link(true, true);
    const { sheet } = sheetWith(session.link);
    void sheet.requester(ask(), {});
    await Promise.resolve();
    expect(sheet.asking).toBe(true);
    // Its own turn's ask IS answered automatically (the same link, same sheet).
    expect(await sheet.requester(ask(), { turnId: "t-1" })).toEqual({
      allowed: true,
      scope: "once",
    });
  });

  test("no link at all (an older daemon): the sheet behaves as before", async () => {
    const { sheet } = sheetWith();
    expect(sheet.autoAccept).toBeNull();
    void sheet.requester(ask(), {});
    await Promise.resolve();
    expect(sheet.asking).toBe(true);
  });

  test("turning the session's switch ON answers the asks that follow, at once", async () => {
    const session = link(true, false);
    const { sheet } = sheetWith(session.link);
    const first = sheet.requester(ask(), {});
    await Promise.resolve();
    expect(sheet.asking).toBe(true);
    // The screen's switch: the session's value, for every device.
    session.link.set(true);
    expect(session.sent).toEqual([true]);
    sheet.answer("allow_once", 10_000);
    expect(await first).toEqual({ allowed: true, scope: "once" });
    // From here the sheet never sees an eligible ask.
    expect(await sheet.requester(ask(), { turnId: "t-1" })).toEqual({
      allowed: true,
      scope: "once",
    });
    expect(sheet.asking).toBe(false);
  });

  test("the switch reads and writes the session's link (one value, every device)", () => {
    const session = link(true, false);
    const { sheet } = sheetWith(session.link);
    expect(sheet.autoAccept).toBe(session.link);
    expect(sheet.autoAccept?.shared()).toBe(true);
    sheet.autoAccept?.set(true);
    expect(session.link.current()).toBe(true);
    expect(session.sent).toEqual([true]);
  });
});
