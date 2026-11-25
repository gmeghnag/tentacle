import { describe, expect, test } from "bun:test";
import { DEBUGGER_IDLE_MS, createOps } from "../src/ops.js";

type Any = Record<string, unknown>;

function setup(tabsInfo: Record<number, Any> = {}) {
  const sent: Any[] = [];
  const calls: string[] = [];
  const timers: { fn: () => void; ms: number; id: number }[] = [];
  let nextTab = 100;
  const chrome = {
    tabs: {
      get: async (id: number) => {
        if (!tabsInfo[id]) throw new Error("no tab");
        return tabsInfo[id];
      },
      create: async (o: Any) => {
        const t = { id: nextTab++, url: o.url, title: "T" };
        tabsInfo[t.id] = t;
        calls.push(`create ${o.url}`);
        return t;
      },
      update: async (id: number, o: Any) => {
        calls.push(`update ${id} ${o.url}`);
        return { id, url: o.url, title: "T" };
      },
      group: async (o: Any) => {
        calls.push(`group ${(o.tabIds as number[]).join(",")} ${o.groupId ?? "new"}`);
        return 7;
      },
      sendMessage: async (id: number, m: Any) => {
        calls.push(`msg ${id} ${m.kind}`);
        return { value: { ok: 1 } };
      },
    },
    tabGroups: {
      update: async (g: number, o: Any) => {
        calls.push(`groupTitle ${g} ${o.title}`);
      },
    },
    scripting: { executeScript: async () => {} },
    debugger: {
      attach: async (t: Any) => {
        calls.push(`attach ${t.tabId}`);
      },
      detach: async (t: Any) => {
        calls.push(`detach ${t.tabId}`);
      },
      sendCommand: async (t: Any, m: string) => {
        calls.push(`cmd ${t.tabId} ${m}`);
      },
    },
  };
  let tid = 0;
  const ops = createOps({
    // biome-ignore lint/suspicious/noExplicitAny: fake chrome
    chrome: chrome as any,
    send: (m: Any) => sent.push(m),
    setTimer: ((fn: () => void, ms: number) => {
      timers.push({ fn, ms, id: ++tid });
      return tid;
    }) as never,
    clearTimer: ((id: number) => {
      const i = timers.findIndex((t) => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    }) as never,
  });
  return { ops, sent, calls, timers, tabsInfo };
}

const claim = (ops: ReturnType<typeof setup>["ops"]) =>
  ops.handle({ op: "claim", sessionUid: "s1", title: "demo" });

describe("browser extension ops", () => {
  test("open creates a background tab in ONE group titled per session", async () => {
    const { ops, calls } = setup();
    await claim(ops);
    const r = await ops.handle({ op: "open", sessionUid: "s1", url: "https://a.test/" });
    expect(r).toMatchObject({ ok: true, result: { tab: 100 } });
    expect(calls).toContain("group 100 new");
    expect(calls).toContain("groupTitle 7 tentacle · demo");
    await ops.handle({ op: "open", sessionUid: "s1", url: "https://b.test/" });
    expect(calls).toContain("group 101 7");
  });

  test("open refuses non-http(s) and an unclaimed session", async () => {
    const { ops } = setup();
    expect(
      await ops.handle({ op: "open", sessionUid: "s1", url: "https://a.test/" }),
    ).toMatchObject({
      ok: false,
    });
    await claim(ops);
    for (const url of [
      "chrome://settings",
      "chrome-extension://abc/x.html",
      "file:///etc/passwd",
    ]) {
      expect(await ops.handle({ op: "open", sessionUid: "s1", url })).toMatchObject({ ok: false });
    }
  });

  test("read refuses extension / chrome pages, and a closed tab", async () => {
    const { ops } = setup({
      1: { id: 1, url: "chrome-extension://x/p.html" },
      2: { id: 2, url: "chrome://version" },
      3: { id: 3, url: "https://ok.test/" },
    });
    for (const tab of [1, 2]) {
      expect(await ops.handle({ op: "read", sessionUid: "s1", tab, mode: "text" })).toMatchObject({
        ok: false,
        error: expect.stringContaining("cannot be read"),
      });
    }
    expect(await ops.handle({ op: "read", sessionUid: "s1", tab: 9, mode: "text" })).toMatchObject({
      ok: false,
      error: "the user closed this tab",
    });
    expect(await ops.handle({ op: "read", sessionUid: "s1", tab: 3, mode: "text" })).toMatchObject({
      ok: true,
    });
  });

  test("Cancel on the debugging bar is a revocation: no re-attach, event sent", async () => {
    const { ops, sent, calls } = setup({ 5: { id: 5, url: "https://a.test/" } });
    await ops.handle({ op: "net", sessionUid: "s1", tab: 5, action: "start" });
    calls.length = 0;
    ops.onDebuggerDetach({ tabId: 5 }, "canceled_by_user");
    expect(sent).toContainEqual({ event: "detached", tab: 5, reason: "canceled_by_user" });
    expect(calls).not.toContain("attach 5");
  });

  test("cross-site detach (target_closed) re-attaches while traced", async () => {
    const { ops, calls } = setup({ 5: { id: 5, url: "https://a.test/" } });
    await ops.handle({ op: "net", sessionUid: "s1", tab: 5, action: "start" });
    calls.length = 0;
    ops.onDebuggerDetach({ tabId: 5 }, "target_closed");
    await Promise.resolve();
    await Promise.resolve();
    expect(calls).toContain("attach 5");
  });

  test("debugger detaches after 10 idle minutes; a use re-arms the timer", async () => {
    const { ops, timers, calls } = setup({ 5: { id: 5, url: "https://a.test/" } });
    await ops.handle({ op: "net", sessionUid: "s1", tab: 5, action: "start" });
    expect(timers).toHaveLength(1);
    expect(timers[0]?.ms).toBe(DEBUGGER_IDLE_MS);
    await ops.handle({ op: "read", sessionUid: "s1", tab: 5, mode: "text" });
    expect(timers).toHaveLength(1);
    timers[0]?.fn();
    await Promise.resolve();
    expect(calls).toContain("detach 5");
  });

  test("net events flow only for traced tabs", async () => {
    const { ops, sent } = setup({ 5: { id: 5, url: "https://a.test/" } });
    ops.onDebuggerEvent({ tabId: 5 }, "Network.requestWillBeSent", {});
    expect(sent).toHaveLength(0);
    await ops.handle({ op: "net", sessionUid: "s1", tab: 5, action: "start" });
    ops.onDebuggerEvent({ tabId: 5 }, "Network.requestWillBeSent", { a: 1 });
    expect(sent[0]).toMatchObject({ event: "net", tab: 5, tier: "full" });
  });

  test("tab closed: event to the hub and the debugger is released", async () => {
    const { ops, sent, calls } = setup({ 5: { id: 5, url: "https://a.test/" } });
    await ops.handle({ op: "net", sessionUid: "s1", tab: 5, action: "start" });
    ops.onTabRemoved(5);
    expect(sent).toContainEqual({ event: "tab_closed", tab: 5 });
    expect(calls).toContain("detach 5");
  });

  test("release retitles the group and detaches its tabs; handover only for a claimed session", async () => {
    const { ops, calls, sent } = setup();
    await claim(ops);
    await ops.handle({ op: "open", sessionUid: "s1", url: "https://a.test/" });
    await ops.handle({ op: "release", sessionUid: "s1" });
    expect(calls).toContain("groupTitle 7 tentacle · demo (ended)");
    expect(ops.handover("nope", 3)).toBe(false);
    expect(sent.some((m) => m.event === "handover")).toBe(false);
    await claim(ops);
    expect(ops.handover("s1", 3)).toBe(true);
    expect(sent).toContainEqual({ event: "handover", sessionUid: "s1", tab: 3 });
  });
});
