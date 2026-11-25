import { describe, expect, test } from "bun:test";
import type { HubOp } from "@tentacle/browser";
import {
  BROWSER_ACTION_TOOL,
  type PermissionRequest,
  type PermissionRequestOptions,
  type PermissionResponse,
  TOOL_GROUPS,
  type Tool,
  type ToolContext,
  type ToolResult,
} from "@tentacle/core";
import { BROWSER_TOOL_NAMES, type BrowserBackend, createBrowserToolset } from "../src/browser.ts";

// docs/feat/browser-inspect.md B5: the acting tools probe first, ask the
// session's ONE broker (kind browser_action) when the classifier says so, and
// only then act; a closed tab is reopened, never an error.

type Reply = (op: HubOp) => unknown;
const CLOSED = (tab: number) =>
  new Error(`tab ${tab} is not one of this session's tabs (or the user closed it)`);

function fakeBackend(reply: Reply) {
  const ops: HubOp[] = [];
  const backend: BrowserBackend = {
    call: async (op) => {
      ops.push(op);
      if (op.op === "claim") return {};
      return reply(op);
    },
  };
  return { backend, ops };
}

function spyAsk(answer: PermissionResponse = { allowed: true, scope: "once" }) {
  const asked: { req: PermissionRequest; options: PermissionRequestOptions | undefined }[] = [];
  const ask = async (req: PermissionRequest, options?: PermissionRequestOptions) => {
    asked.push({ req, options });
    return answer;
  };
  return { ask, asked };
}

const ctx = (sessionId = "session-1"): ToolContext =>
  ({
    sessionId,
    signal: new AbortController().signal,
    env: {},
    toolCallId: "call-1",
  }) as unknown as ToolContext;

function tools(backend: BrowserBackend, ask?: ReturnType<typeof spyAsk>["ask"]) {
  const set = createBrowserToolset({ backend, launchPollMs: 1 });
  const list = set.tools({ maxEdge: 1568, maxImageBytes: 5_000_000, ...(ask ? { ask } : {}) });
  const by = (name: string): Tool<unknown> => {
    const t = list.find((x) => x.name === name);
    if (t === undefined) throw new Error(`no ${name}`);
    return t as Tool<unknown>;
  };
  const exec = (name: string, input: unknown, c: ToolContext = ctx()): Promise<ToolResult> =>
    by(name).execute(by(name).inputSchema.parse(input), c);
  return { list, by, exec };
}

const acts = (ops: HubOp[], op: "click" | "type") =>
  ops.filter((o) => o.op === op && !("probe" in o && o.probe === true));

/** A hub with tab 5 open on a.test (visited by the open) and the given probe facts. */
function page(facts: Record<string, unknown>, handedOver = false) {
  return fakeBackend((op) => {
    if (op.op === "open") return { tab: 5, url: "https://a.test/", title: "A" };
    if ((op.op === "click" || op.op === "type") && op.probe === true) return { facts, handedOver };
    if (op.op === "click") return { facts, clicked: true };
    if (op.op === "type") return { facts, typed: "••••" };
    return {};
  });
}

describe("browser action tools (B5)", () => {
  test("the group has the nine tools; none asks statically (the tools ask themselves)", () => {
    const { list } = tools(fakeBackend(() => ({})).backend);
    expect(TOOL_GROUPS.browser).toEqual([...BROWSER_TOOL_NAMES]);
    expect(list.map((t) => t.name)).toEqual([...BROWSER_TOOL_NAMES]);
    expect(BROWSER_TOOL_NAMES).toContain("browser_click");
    expect(BROWSER_TOOL_NAMES).toContain("browser_type");
    expect(BROWSER_TOOL_NAMES).toContain("browser_close");
    expect(list.filter((t) => t.permission !== "none")).toEqual([]);
  });

  test("a submit click: probe, then ONE browser_action ask through the injected broker, then the click", async () => {
    const { backend, ops } = page({ tag: "button", name: "Save", submits: true });
    const spy = spyAsk();
    const t = tools(backend, spy.ask);
    await t.exec("browser_open", { url: "https://a.test/" });
    spy.asked.length = 0; // the first open asked (new domain); not under test here
    const r = await t.exec("browser_click", { tab: 5, ref: "e3" });
    expect(r.isError).toBeUndefined();
    expect(spy.asked).toHaveLength(1);
    const a = spy.asked[0];
    expect(a?.req.kind).toBe("browser_action");
    expect(a?.req.tool).toBe(BROWSER_ACTION_TOOL);
    expect(a?.req.detail).toContain("submits a form");
    expect(a?.options?.toolCallId).toBe("call-1");
    const order = ops
      .filter((o) => o.op === "click")
      .map((o) => ("probe" in o && o.probe ? "probe" : "act"));
    expect(order).toEqual(["probe", "act"]);
  });

  test("a denied ask never acts, and the model is told", async () => {
    const { backend, ops } = page({ tag: "button", name: "Delete account" });
    const spy = spyAsk({ allowed: false, message: "not that one" });
    const t = tools(backend, spy.ask);
    const r = await t.exec("browser_click", { tab: 5, ref: "e1" });
    expect(r.isError).toBe(true);
    expect(r.content).toContain("declined");
    expect(r.content).toContain("not that one");
    expect(acts(ops, "click")).toHaveLength(0);
  });

  test("an ordinary same-domain link click does not ask", async () => {
    const { backend, ops } = page({ tag: "a", name: "Docs", href: "https://a.test/docs" });
    const spy = spyAsk();
    const t = tools(backend, spy.ask);
    await t.exec("browser_open", { url: "https://a.test/" });
    spy.asked.length = 0;
    await t.exec("browser_click", { tab: 5, ref: "e2" });
    expect(spy.asked).toHaveLength(0);
    expect(acts(ops, "click")).toHaveLength(1);
  });

  test("the first action on a handed-over tab asks", async () => {
    const { backend } = page({ tag: "a", name: "Docs" }, true);
    const spy = spyAsk();
    await tools(backend, spy.ask).exec("browser_click", { tab: 5, ref: "e2" });
    expect(spy.asked[0]?.req.detail).toContain("handed over");
  });

  test("no broker wired: an action that needs an ask is refused, never done", async () => {
    const { backend, ops } = page({ tag: "button", name: "Pay now" });
    const r = await tools(backend).exec("browser_click", { tab: 5, ref: "e1" });
    expect(r.isError).toBe(true);
    expect(acts(ops, "click")).toHaveLength(0);
  });

  test("typing into a password field asks, and the ask never shows the text", async () => {
    const { backend, ops } = page({ tag: "input", type: "password", name: "Password" });
    const spy = spyAsk();
    const r = await tools(backend, spy.ask).exec("browser_type", {
      tab: 5,
      ref: "e4",
      text: "hunter2secret",
    });
    expect(r.isError).toBeUndefined();
    expect(spy.asked).toHaveLength(1);
    expect(JSON.stringify(spy.asked[0]?.req)).not.toContain("hunter2secret");
    expect(r.content).not.toContain("hunter2secret");
    expect(acts(ops, "type")).toHaveLength(1);
  });

  test("open: a new domain asks; once allowed, the same domain does not; a denied open never navigates", async () => {
    const { backend, ops } = page({ tag: "a" });
    const spy = spyAsk();
    const t = tools(backend, spy.ask);
    await t.exec("browser_open", { url: "https://a.test/x" });
    await t.exec("browser_open", { url: "https://www.a.test/y" });
    expect(spy.asked).toHaveLength(1);
    expect(spy.asked[0]?.req.kind).toBe("browser_action");

    const denied = fakeBackend(() => ({ tab: 1 }));
    const no = tools(denied.backend, spyAsk({ allowed: false }).ask);
    const r = await no.exec("browser_open", { url: "https://b.test/" });
    expect(r.isError).toBe(true);
    expect(denied.ops.filter((o) => o.op === "open")).toHaveLength(0);
  });

  test("close: an own tab is closed; one already closed is not an error", async () => {
    let gone = false;
    const { backend } = fakeBackend((op) => {
      if (op.op === "close") {
        if (gone) throw CLOSED(op.tab);
        gone = true;
        return { closed: true, released: false };
      }
      return {};
    });
    const t = tools(backend);
    expect((await t.exec("browser_close", { tab: 5 })).content).toContain("closed tab 5");
    const again = await t.exec("browser_close", { tab: 5 });
    expect(again.isError).toBeUndefined();
    expect(again.content).toContain("already closed");
  });

  test("a closed tab is reopened at its last URL (no ask) and the op runs there; the old id follows", async () => {
    let next = 5;
    const open = new Set<number>();
    const { backend, ops } = fakeBackend((op) => {
      if (op.op === "open") {
        const tab = next++;
        open.add(tab);
        return { tab, url: op.url, title: "A" };
      }
      if (op.op === "close") {
        open.delete(op.tab);
        return { closed: true, released: false };
      }
      if (op.op === "read") {
        if (!open.has(op.tab)) throw CLOSED(op.tab);
        return { url: "https://a.test/page", title: "A", text: `body of ${op.tab}` };
      }
      return {};
    });
    const spy = spyAsk();
    const t = tools(backend, spy.ask);
    await t.exec("browser_open", { url: "https://a.test/page" });
    await t.exec("browser_close", { tab: 5 });
    spy.asked.length = 0;
    const r = await t.exec("browser_read", { tab: 5 });
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("tab 5 was closed; reopened https://a.test/page as tab 6");
    expect(r.content).toContain("body of 6");
    expect(spy.asked).toHaveLength(0);
    // The model may keep saying 5: it reaches 6, with no second reopen.
    const again = await t.exec("browser_read", { tab: 5 });
    expect(again.content).toContain("body of 6");
    expect(ops.filter((o) => o.op === "open")).toHaveLength(2);
  });

  test("an unknown tab is never reopened; a reopen that fails is the ordinary error", async () => {
    const { backend, ops } = fakeBackend((op) => {
      if (op.op === "open" && ops.filter((o) => o.op === "open").length > 1) {
        throw new Error("the page could not load");
      }
      if (op.op === "open") return { tab: 5, url: op.url, title: "A" };
      if (op.op === "read") throw CLOSED(op.tab);
      return {};
    });
    const t = tools(backend, spyAsk().ask);
    const unknown = await t.exec("browser_read", { tab: 9 });
    expect(unknown.isError).toBe(true);
    expect(ops.filter((o) => o.op === "open")).toHaveLength(0);
    await t.exec("browser_open", { url: "https://a.test/" });
    const failed = await t.exec("browser_read", { tab: 5 });
    expect(failed.isError).toBe(true);
    expect(failed.content).toContain("could not load");
  });
});
