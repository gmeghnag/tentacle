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
      remove: async (id: number) => {
        calls.push(`remove ${id}`);
      },
      ungroup: async (id: number) => {
        calls.push(`ungroup ${id}`);
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
  const scaled: unknown[] = [];
  const ops = createOps({
    scale: (async (b64: string, maxEdge?: number) => {
      scaled.push(maxEdge);
      return `${b64}@${maxEdge ?? "full"}`;
    }) as never,
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
  return { ops, sent, calls, timers, tabsInfo, chrome: chrome as Any, scaled };
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
    expect(calls).toContain("groupTitle 7 demo");
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

  test("retitle (B5b) renames the session's group and keeps its tabs; an unclaimed session is refused", async () => {
    // Mutation: retitle re-runs claim (resets the session) → the next open makes a NEW group.
    const { ops, calls } = setup();
    expect(await ops.handle({ op: "retitle", sessionUid: "s1", title: "x" })).toMatchObject({
      ok: false,
    });
    await claim(ops);
    // Before any tab: the title is kept for the group the first open makes.
    await ops.handle({ op: "retitle", sessionUid: "s1", title: "Fix login" });
    await ops.handle({ op: "open", sessionUid: "s1", url: "https://a.test/" });
    expect(calls).toContain("groupTitle 7 Fix login");
    expect(
      await ops.handle({ op: "retitle", sessionUid: "s1", title: "Fix login form" }),
    ).toMatchObject({ ok: true });
    expect(calls.at(-1)).toBe("groupTitle 7 Fix login form");
    await ops.handle({ op: "open", sessionUid: "s1", url: "https://b.test/" });
    expect(calls).toContain("group 101 7");
    const tabs = await ops.handle({ op: "tabs", sessionUid: "s1" });
    expect(tabs).toMatchObject({ ok: true });
  });

  test("release detaches its tabs; handover only for a claimed session", async () => {
    const { ops, calls, sent } = setup();
    await claim(ops);
    await ops.handle({ op: "open", sessionUid: "s1", url: "https://a.test/" });
    await ops.handle({ op: "release", sessionUid: "s1" });
    expect(calls.filter((c) => c.startsWith("groupTitle"))).toEqual(["groupTitle 7 demo"]);
    expect(await ops.handover("nope", 3)).toBe(false);
    expect(sent.some((m) => m.event === "handover")).toBe(false);
    await claim(ops);
    expect(await ops.handover("s1", 3)).toBe(true);
    expect(sent).toContainEqual({ event: "handover", sessionUid: "s1", tab: 3 });
  });

  test("a handed-over tab joins the session's group, so the user sees it (D1, fix round 1)", async () => {
    const { ops, calls, sent } = setup();
    await claim(ops);
    await ops.handle({ op: "open", sessionUid: "s1", url: "https://a.test/" });
    expect(await ops.handover("s1", 3)).toBe(true);
    expect(calls).toContain("group 3 7");
    expect(sent).toContainEqual({ event: "handover", sessionUid: "s1", tab: 3 });
    // A tab Chrome refuses to group is not handed over (the user could not see it).
    const refused = setup();
    await claim(refused.ops);
    (refused.chrome.tabs as Any).group = async () => {
      throw new Error("no such tab");
    };
    expect(await refused.ops.handover("s1", 3)).toBe(false);
    expect(refused.sent.some((m) => m.event === "handover")).toBe(false);
  });

  test("dragging an owned tab out of the group takes it back: tab_closed, debugger released, no feed (§6)", async () => {
    const { ops, sent, calls } = setup({ 100: { id: 100, url: "https://a.test/" } });
    await claim(ops);
    await ops.handle({ op: "open", sessionUid: "s1", url: "https://a.test/" });
    await ops.handle({ op: "net", sessionUid: "s1", tab: 100, action: "start" });
    const feed = {
      tabId: 100,
      url: "https://a.test/x",
      method: "GET",
      statusCode: 200,
      type: "xhr",
    };
    // Owned: the headers feed flows; a regroup INTO our own group is no take-back.
    ops.onWebRequest(feed);
    expect(sent.filter((m) => m.event === "net")).toHaveLength(1);
    ops.onTabUpdated(100, { groupId: 7 });
    expect(sent).not.toContainEqual({ event: "tab_closed", tab: 100 });
    // Dragged out (ungrouped = -1).
    ops.onTabUpdated(100, { groupId: -1 });
    expect(sent).toContainEqual({ event: "tab_closed", tab: 100 });
    await Promise.resolve();
    expect(calls).toContain("detach 100");
    ops.onWebRequest(feed);
    expect(sent.filter((m) => m.event === "net")).toHaveLength(1);
    // Not ours at all: never a tab_closed, never a feed.
    ops.onTabUpdated(55, { groupId: -1 });
    ops.onWebRequest({ ...feed, tabId: 55 });
    expect(sent).not.toContainEqual({ event: "tab_closed", tab: 55 });
    expect(sent.filter((m) => m.event === "net")).toHaveLength(1);
  });

  test("close: an own tab is closed; a handed-over one is released to the user, never closed (B5)", async () => {
    const { ops, sent, calls } = setup({
      100: { id: 100, url: "https://a.test/" },
      8: { id: 8, url: "https://mine.test/" },
    });
    await claim(ops);
    await ops.handle({ op: "open", sessionUid: "s1", url: "https://a.test/" });
    expect(await ops.handover("s1", 8)).toBe(true);

    expect(await ops.handle({ op: "close", sessionUid: "s1", tab: 8 })).toEqual({
      ok: true,
      result: { closed: false, released: true },
    });
    expect(calls).toContain("ungroup 8");
    expect(calls).not.toContain("remove 8");
    expect(sent).toContainEqual({ event: "tab_closed", tab: 8 });

    expect(await ops.handle({ op: "close", sessionUid: "s1", tab: 100 })).toEqual({
      ok: true,
      result: { closed: true, released: false },
    });
    expect(calls).toContain("remove 100");
  });
});

describe("browser extension ops: read-only tools (B4)", () => {
  test("shot of the ACTIVE tab uses captureVisibleTab — no debugger, no infobar", async () => {
    const s = setup({ 5: { id: 5, url: "https://a.test/", active: true, windowId: 2 } });
    (s.chrome.tabs as Any).captureVisibleTab = async (w: number) => {
      s.calls.push(`capture ${w}`);
      return "data:image/jpeg;base64,QUJD";
    };
    const r = await s.ops.handle({ op: "shot", sessionUid: "s1", tab: 5, maxEdge: 768 });
    expect(r).toEqual({
      ok: true,
      result: { mimeType: "image/jpeg", data: "QUJD@768", via: "visible" },
    });
    expect(s.calls).toEqual(["capture 2"]);
  });

  test("shot of a BACKGROUND tab attaches the debugger on demand (Page.captureScreenshot)", async () => {
    const s = setup({ 5: { id: 5, url: "https://a.test/", active: false } });
    (s.chrome.debugger as Any).sendCommand = async (t: Any, m: string) => {
      s.calls.push(`cmd ${t.tabId} ${m}`);
      return m === "Page.captureScreenshot" ? { data: "WFla" } : undefined;
    };
    const r = await s.ops.handle({ op: "shot", sessionUid: "s1", tab: 5 });
    expect(r).toMatchObject({ ok: true, result: { data: "WFla@full", via: "debugger" } });
    expect(s.calls).toContain("attach 5");
    expect(s.calls).toContain("cmd 5 Page.captureScreenshot");
    // …and the idle detach is armed like for tracing.
    expect(s.timers.some((t) => t.ms === DEBUGGER_IDLE_MS)).toBe(true);
  });

  test("shot refuses an extension page (U4) before touching Chrome's capture", async () => {
    const s = setup({ 5: { id: 5, url: "chrome-extension://x/p.html", active: true } });
    expect(await s.ops.handle({ op: "shot", sessionUid: "s1", tab: 5 })).toMatchObject({
      ok: false,
    });
    expect(s.calls).toEqual([]);
  });

  test("console injects the MAIN-world hook, then reads the page's ring", async () => {
    const s = setup({ 5: { id: 5, url: "https://a.test/" } });
    const injected: Any[] = [];
    (s.chrome.scripting as Any).executeScript = async (o: Any) => {
      injected.push(o);
    };
    const r = await s.ops.handle({ op: "console", sessionUid: "s1", tab: 5, cursor: 3 });
    expect(r).toMatchObject({ ok: true });
    expect(injected[0]).toMatchObject({
      target: { tabId: 5 },
      world: "MAIN",
      files: ["src/console-hook.js"],
    });
    expect(s.calls).toContain("msg 5 console");
  });

  test("a navigation hooks the console ONLY in a tab a session owns", async () => {
    const s = setup();
    const injected: number[] = [];
    (s.chrome.scripting as Any).executeScript = async (o: Any) => {
      injected.push((o.target as Any).tabId as number);
    };
    s.ops.onTabUpdated(42, { status: "loading" });
    await claim(s.ops);
    await s.ops.handle({ op: "open", sessionUid: "s1", url: "https://a.test/" });
    injected.length = 0;
    s.ops.onTabUpdated(100, { status: "loading" });
    s.ops.onTabUpdated(100, { status: "complete" });
    s.ops.onTabUpdated(42, { status: "loading" });
    await Promise.resolve();
    expect(injected).toEqual([100]);
  });

  test("body needs full tracing; a binary body is size + sha256, never bytes", async () => {
    const s = setup({ 5: { id: 5, url: "https://a.test/" } });
    expect(
      await s.ops.handle({ op: "body", sessionUid: "s1", tab: 5, requestId: "r1" }),
    ).toMatchObject({ ok: false, error: expect.stringContaining("browser_net start") });
    await s.ops.handle({ op: "net", sessionUid: "s1", tab: 5, action: "start" });
    (s.chrome.debugger as Any).sendCommand = async () => ({
      body: "AAEC",
      base64Encoded: true,
    });
    const bin = await s.ops.handle({ op: "body", sessionUid: "s1", tab: 5, requestId: "r1" });
    expect(bin).toMatchObject({ ok: true, result: { binary: true, size: 3 } });
    expect((bin.result as Any).sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(bin)).not.toContain("AAEC");
    (s.chrome.debugger as Any).sendCommand = async () => ({ body: "hi", base64Encoded: false });
    expect(await s.ops.handle({ op: "body", sessionUid: "s1", tab: 5, requestId: "r1" })).toEqual({
      ok: true,
      result: { binary: false, size: 2, text: "hi", truncated: false },
    });
  });
});
