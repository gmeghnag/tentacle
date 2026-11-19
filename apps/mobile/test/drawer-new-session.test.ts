/**
 * New session from the drawer (docs/feat/mobile-chrome.md slice S7, F8).
 *
 * `createFreshSession`: the phone-minted id is CREATED at the tap
 * (`session/open{create}` through a handle built without `attach`), then
 * detached, so the Session screen's normal attach finds it. A failure is a typed
 * reason, never a throw. `createDrawerNewSession`: offered only on an online
 * computer, one create at a time, a failure stays visible and navigates nowhere.
 *
 * Fakes only; the daemon end is `new-session-link.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import {
  NEW_SESSION_TITLE,
  createDrawerNewSession,
  newSessionErrorText,
  newSessionFromHub,
  newSessionPill,
} from "../src/drawer-new-session.ts";
import { type FreshHandle, createFreshSession } from "../src/session-controller.ts";

function fresh(log: string[], fail?: { readonly open?: unknown; readonly detach?: unknown }) {
  const handle: FreshHandle = {
    async openSeeded() {
      log.push("create");
      if (fail?.open !== undefined) {
        throw fail.open;
      }
    },
    async detach() {
      log.push("detach");
      // Settles a macrotask later, like a real RPC round trip: a caller that
      // does not AWAIT the detach answers before "detach-done" is logged.
      await new Promise((resolve) => setTimeout(resolve, 0));
      log.push("detach-done");
      if (fail?.detach !== undefined) {
        throw fail.detach;
      }
    },
  };
  return handle;
}

describe("createFreshSession", () => {
  test("creates, THEN detaches, and only then answers ok (the screen's attach must not race the detach)", async () => {
    const log: string[] = [];
    const result = await createFreshSession(fresh(log));
    log.push("answered");
    expect(result).toEqual({ ok: true });
    expect(log).toEqual(["create", "detach", "detach-done", "answered"]);
  });

  test("a failed create is a typed reason by error code, and nothing is detached", async () => {
    const log: string[] = [];
    const tooMany = await createFreshSession(
      fresh(log, { open: new RpcError(DomainErrorCode.TooManySessions, "x") }),
    );
    expect(tooMany).toEqual({ ok: false, reason: "too-many" });
    expect(log).toEqual(["create"]);
    const down = await createFreshSession(fresh([], { open: new Error("socket closed") }));
    expect(down).toEqual({ ok: false, reason: "link" });
  });

  test("a failed detach after a create is still ok: the session exists, the screen attaches it", async () => {
    const result = await createFreshSession(fresh([], { detach: new Error("gone") }));
    expect(result).toEqual({ ok: true });
  });
});

describe("createDrawerNewSession", () => {
  function setup(answer: () => Promise<{ ok: true } | { ok: false; reason: "link" | "too-many" }>) {
    const calls: { computerId: string; sessionId: string }[] = [];
    const opened: { computerId: string; sessionId: string }[] = [];
    let n = 0;
    const flow = createDrawerNewSession({
      mint: () => `id-${++n}`,
      create: (computerId, sessionId) => {
        calls.push({ computerId, sessionId });
        return answer();
      },
      opened: (computerId, sessionId) => opened.push({ computerId, sessionId }),
    });
    return { flow, calls, opened };
  }

  test("on an online computer: creates under a minted id on THAT computer, then opens it", async () => {
    const { flow, calls, opened } = setup(async () => ({ ok: true }));
    await flow.start("mac-b", true);
    expect(calls).toEqual([{ computerId: "mac-b", sessionId: "id-1" }]);
    expect(opened).toEqual([{ computerId: "mac-b", sessionId: "id-1" }]);
    expect(flow.state()).toEqual({ creating: false, error: null });
  });

  test("F8: offline (canCreate false) sends nothing and opens nothing", async () => {
    const { flow, calls, opened } = setup(async () => ({ ok: true }));
    await flow.start("mac-a", false);
    expect(calls).toEqual([]);
    expect(opened).toEqual([]);
  });

  test("a second tap while the first create is in flight creates nothing more", async () => {
    const gate: { release: () => void } = { release: () => {} };
    const { flow, calls, opened } = setup(
      () =>
        new Promise((resolve) => {
          gate.release = () => resolve({ ok: true });
        }),
    );
    const first = flow.start("mac-a", true);
    expect(flow.state().creating).toBe(true);
    await flow.start("mac-a", true);
    expect(calls).toHaveLength(1);
    gate.release();
    await first;
    expect(opened).toHaveLength(1);
  });

  test("F8: a failed create opens nothing and SAYS why; the next tap clears it and retries", async () => {
    let ok = false;
    const { flow, calls, opened } = setup(async () =>
      ok ? { ok: true } : { ok: false, reason: "link" },
    );
    await flow.start("mac-a", true);
    expect(opened).toEqual([]);
    expect(flow.state()).toEqual({ creating: false, error: newSessionErrorText("link") });
    ok = true;
    await flow.start("mac-a", true);
    expect(calls.map((c) => c.sessionId)).toEqual(["id-1", "id-2"]);
    expect(opened).toEqual([{ computerId: "mac-a", sessionId: "id-2" }]);
    expect(flow.state().error).toBeNull();
  });

  test("dismiss clears a shown failure; listeners hear every change", async () => {
    const { flow } = setup(async () => ({ ok: false, reason: "too-many" }));
    let heard = 0;
    flow.subscribe(() => {
      heard += 1;
    });
    await flow.start("mac-a", true);
    expect(flow.state().error).toBe(newSessionErrorText("too-many"));
    flow.dismiss();
    expect(flow.state().error).toBeNull();
    expect(heard).toBe(3); // creating, failed, dismissed
  });

  test("the pill: enabled only on an online computer and not while creating (F8)", () => {
    const idle = { creating: false, error: null };
    expect(newSessionPill(true, idle)).toEqual({ enabled: true, busy: false, error: null });
    expect(newSessionPill(false, idle).enabled).toBe(false);
    expect(newSessionPill(true, { creating: true, error: null })).toEqual({
      enabled: false,
      busy: true,
      error: null,
    });
    // A failure stays readable even once the computer went offline.
    expect(newSessionPill(false, { creating: false, error: "x" }).error).toBe("x");
  });

  test("every failure reason has its own sentence, and the new row's title is fixed", () => {
    const texts = (["link", "timeout", "too-many", "gone", "archived", "deleted"] as const).map(
      newSessionErrorText,
    );
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(0);
    }
    expect(newSessionErrorText("too-many")).not.toBe(newSessionErrorText("link"));
    expect(NEW_SESSION_TITLE).toBe("(new)");
  });
});

/**
 * New session from the HUB (fix/mobile-hub-new-session, flow 34-hub-new). The
 * drawer's gate is the drawer TITLE's online probe, which runs only while the
 * drawer is open — so from the hub (drawer never opened) it read "not known" as
 * "offline" and the tap did nothing at all. The hub path probes NOW.
 */
describe("newSessionFromHub", () => {
  function setup(options: { online: boolean | Error; create?: "ok" | "link" }) {
    const log: string[] = [];
    const session = createDrawerNewSession({
      mint: () => "fresh-1",
      create: async (computerId, sessionId) => {
        log.push(`create:${computerId}:${sessionId}`);
        return options.create === "link" ? { ok: false, reason: "link" } : { ok: true };
      },
      opened: (computerId, sessionId) => log.push(`opened:${computerId}:${sessionId}`),
    });
    const run = () =>
      newSessionFromHub({
        computerId: "c1",
        probe: async () => {
          log.push("probe");
          if (options.online instanceof Error) {
            throw options.online;
          }
          return options.online;
        },
        session,
        showDrawer: () => log.push("drawer"),
      });
    return { log, run, session };
  }

  test("online: probes, creates on the listed computer and opens it — no drawer", async () => {
    const h = setup({ online: true });
    await h.run();
    expect(h.log).toEqual(["probe", "create:c1:fresh-1", "opened:c1:fresh-1"]);
  });

  test("offline: nothing is created, and the drawer opens to say why (never a silent no-op)", async () => {
    const h = setup({ online: false });
    await h.run();
    expect(h.log).toEqual(["probe", "drawer"]);
  });

  test("a probe that throws reads as offline (the drawer shows it), never a throw", async () => {
    const h = setup({ online: new Error("no link") });
    await h.run();
    expect(h.log).toEqual(["probe", "drawer"]);
  });

  test("a create that fails opens the drawer, where its error is drawn", async () => {
    const h = setup({ online: true, create: "link" });
    await h.run();
    expect(h.log).toEqual(["probe", "create:c1:fresh-1", "drawer"]);
    expect(h.session.state().error).toBe(newSessionErrorText("link"));
  });
});
