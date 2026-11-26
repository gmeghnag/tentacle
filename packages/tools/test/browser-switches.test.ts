import { describe, expect, test } from "bun:test";
import type { HubOp } from "@tentacle/browser";
import type {
  PermissionRequest,
  PermissionResponse,
  Tool,
  ToolContext,
  ToolResult,
} from "@tentacle/core";
import { type BrowserBackend, createBrowserToolset } from "../src/browser.ts";

// docs/feat/browser-inspect.md B5b: the `secrets` switch picks the result's
// redactor per call (an ask stays masked), the gate marks auto-eligibility,
// and `status` / `retitle` for the host's port. Each test names its mutation.

function fakeBackend(reply: (op: HubOp) => unknown) {
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

const ctx = (secrets?: "masked" | "clear"): ToolContext =>
  ({
    sessionId: "session-1",
    signal: new AbortController().signal,
    env: {},
    toolCallId: "call-1",
    ...(secrets ? { browserSecrets: () => secrets } : {}),
  }) as unknown as ToolContext;

function rig(reply: (op: HubOp) => unknown, answer: PermissionResponse = { allowed: true }) {
  const { backend, ops } = fakeBackend(reply);
  const asked: PermissionRequest[] = [];
  const set = createBrowserToolset({
    backend,
    // The host's generic net: masks one marker, so we can see it is skipped in clear.
    textNet: (t) => t.replaceAll("NETSECRET", "[net-masked]"),
  });
  const list = set.tools({
    maxEdge: 1568,
    maxImageBytes: 5_000_000,
    ask: async (req) => {
      asked.push(req);
      return answer;
    },
  });
  const exec = (name: string, input: unknown, c: ToolContext): Promise<ToolResult> => {
    const t = list.find((x) => x.name === name) as Tool<unknown>;
    return t.execute(t.inputSchema.parse(input), c);
  };
  return { set, ops, asked, exec };
}

const PAGE = {
  title: "Inbox NETSECRET",
  url: "https://a.test/cb?token=SECRET9",
  text: "see https://x.test/?code=SECRET8",
};
const NET_ENTRY = {
  seq: 1,
  tier: "full",
  entry: {
    method: "Network.requestWillBeSent",
    params: {
      request: {
        url: "https://a.test/?token=SECRET7",
        headers: { Authorization: "Bearer SECRET6" },
      },
    },
  },
};

function hub(facts: Record<string, unknown> = {}) {
  return (op: HubOp): unknown => {
    if (op.op === "open") return { tab: 5, url: "https://a.test/", title: "A" };
    if (op.op === "read") return PAGE;
    if (op.op === "net") return NET_ENTRY;
    if ((op.op === "click" || op.op === "type") && op.probe === true) return { facts };
    if (op.op === "click" || op.op === "type") return { facts, typed: "x" };
    return {};
  };
}

describe("the secrets switch", () => {
  test("read: page secrets and the net's marker are masked by default and in masked, visible in clear", async () => {
    // Mutation: ignore `browserSecrets` in `run` → clear still masks.
    const r = rig(hub());
    await r.exec("browser_open", { url: "https://a.test/" }, ctx());
    for (const c of [ctx(), ctx("masked")]) {
      const out = (await r.exec("browser_read", { tab: 5 }, c)).content;
      expect(out).not.toContain("SECRET9");
      expect(out).not.toContain("SECRET8");
      expect(out).not.toContain("NETSECRET");
    }
    const clear = (await r.exec("browser_read", { tab: 5 }, ctx("clear"))).content;
    expect(clear).toContain("SECRET9");
    expect(clear).toContain("SECRET8");
    expect(clear).toContain("NETSECRET");
    // Back to masked: masks again (only new results).
    expect((await r.exec("browser_read", { tab: 5 }, ctx("masked"))).content).not.toContain(
      "SECRET9",
    );
  });

  test("net get: headers and URL params masked, visible in clear", async () => {
    // Mutation: `netGet` uses the session's redactor in every mode → clear masks.
    const r = rig(hub());
    await r.exec("browser_open", { url: "https://a.test/" }, ctx());
    const masked = (await r.exec("browser_net", { tab: 5, op: "get", id: 1 }, ctx())).content;
    expect(masked).not.toContain("SECRET7");
    expect(masked).not.toContain("SECRET6");
    const clear = (await r.exec("browser_net", { tab: 5, op: "get", id: 1 }, ctx("clear"))).content;
    expect(clear).toContain("SECRET7");
    expect(clear).toContain("SECRET6");
  });

  test("an ask's title stays masked in clear (it travels to the phone)", async () => {
    // Mutation: `gate` uses `clean` (the mode's redactor) → the token reaches the ask.
    const r = rig(
      hub({ tag: "a", name: "https://a.test/?token=SECRET5 NETSECRET", submits: true }),
    );
    await r.exec("browser_open", { url: "https://a.test/" }, ctx());
    await r.exec("browser_click", { tab: 5, ref: "e1" }, ctx("clear"));
    expect(r.asked).toHaveLength(2); // the open of a new domain, then the action
    const shown = `${r.asked[1]?.title} ${r.asked[1]?.detail}`;
    expect(shown).not.toContain("SECRET5");
    expect(shown).not.toContain("NETSECRET");
  });
});

describe("auto eligibility (the `browserAuto` slack)", () => {
  test.each([
    [
      "a submit click",
      "browser_click",
      { tab: 5, ref: "e1" },
      { tag: "button", name: "Send", submits: true },
      true,
    ],
    [
      "a payment click (hard)",
      "browser_click",
      { tab: 5, ref: "e1" },
      { tag: "button", name: "Pay now" },
      false,
    ],
    [
      "password typing (hard)",
      "browser_type",
      { tab: 5, ref: "e1", text: "hunter2" },
      { tag: "input", type: "password" },
      false,
    ],
  ])("%s → eligible: %p", async (_n, tool, input, facts, eligible) => {
    // Mutation: set the slack on every ask → the hard rows fail.
    const r = rig(hub(facts));
    await r.exec("browser_open", { url: "https://a.test/" }, ctx());
    await r.exec(tool as string, input, ctx());
    expect(r.asked).toHaveLength(2); // the open of a new domain, then the action
    expect(r.asked[1]?.browserAuto === true).toBe(eligible as boolean);
  });
});

describe("status and retitle (the host port's toolset half)", () => {
  test("an unclaimed session: [] and ZERO hub ops (a read never takes the lease)", async () => {
    // Mutation: `status` goes through `call` (claims first) → a claim op appears.
    const r = rig(hub());
    expect(await r.set.status("session-1")).toEqual({ tabs: [] });
    expect(r.ops).toEqual([]);
  });

  test("a claimed session lists its tabs: host + path only, masked, capped", async () => {
    // Mutation: `where` keeps the query → the token reaches the phone.
    const r = rig((op) =>
      op.op === "tabs"
        ? {
            tabs: [
              {
                id: 5,
                title: `NETSECRET ${"t".repeat(300)}`,
                url: "https://a.test/cb?token=SECRET4#frag",
                traced: true,
                handedOver: true,
              },
            ],
          }
        : hub()(op),
    );
    await r.exec("browser_open", { url: "https://a.test/" }, ctx());
    const st = await r.set.status("session-1");
    expect(st.tabs).toHaveLength(1);
    const tab = st.tabs[0];
    expect(tab?.where).toBe("a.test/cb");
    expect(tab?.title).not.toContain("NETSECRET");
    expect(tab?.title.length).toBeLessThanOrEqual(200);
    expect(tab).toMatchObject({ id: 5, traced: true, handedOver: true });
  });

  test("a hub refusal of the lease is heldElsewhere; any other fault is just []", async () => {
    let error = "this session's browser is held by another tentacle process";
    const r = rig((op) => {
      if (op.op === "tabs") throw new Error(error);
      return hub()(op);
    });
    await r.exec("browser_open", { url: "https://a.test/" }, ctx());
    expect(await r.set.status("session-1")).toEqual({ tabs: [], heldElsewhere: true });
    error = "the browser did not answer in time";
    expect(await r.set.status("session-1")).toEqual({ tabs: [] });
  });

  test("a lost lease (hub restarted) is not heldElsewhere: [], the claim is forgotten, no re-claim", async () => {
    // Mutation: map «does not hold» to heldElsewhere, or keep the uid in `claimed`.
    const r = rig((op) => {
      if (op.op === "tabs") throw new Error("this session does not hold the browser");
      return hub()(op);
    });
    await r.exec("browser_open", { url: "https://a.test/" }, ctx());
    expect(await r.set.status("session-1")).toEqual({ tabs: [] });
    const after = r.ops.length;
    expect(r.ops[after - 1]?.op).toBe("tabs"); // the read itself re-claimed nothing
    // Forgotten: the next read makes no hub op at all (a read never takes the lease).
    expect(await r.set.status("session-1")).toEqual({ tabs: [] });
    expect(r.ops.length).toBe(after);
  });

  test("retitle: kept for the first claim; sent to a claimed group; a failure is swallowed", async () => {
    const r = rig((op) => {
      if (op.op === "retitle") throw new Error("unknown op");
      return hub()(op);
    });
    r.set.retitle("session-1", "Fix login");
    expect(r.ops).toEqual([]);
    await r.exec("browser_open", { url: "https://a.test/" }, ctx());
    expect(r.ops[0]).toEqual({ op: "claim", sessionUid: "session-1", title: "Fix login" });
    r.set.retitle("session-1", "Fix login form");
    await new Promise((res) => setTimeout(res, 1));
    expect(r.ops.at(-1)).toEqual({
      op: "retitle",
      sessionUid: "session-1",
      title: "Fix login form",
    });
  });
});
