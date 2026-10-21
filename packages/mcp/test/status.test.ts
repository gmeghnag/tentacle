import { describe, expect, test } from "bun:test";
import { type McpConnection, connectMcpServers } from "../src/connect.ts";
import { McpStatusTracker } from "../src/status.ts";

/** A connection double: its tools (`t0`, `t1`, … unless named), a liveness flag and a scripted ping. */
function fakeConnection(
  name: string,
  opts: {
    tools?: number;
    toolNames?: readonly string[];
    open?: boolean;
    ping?: () => Promise<void>;
  } = {},
): McpConnection {
  const toolNames = opts.toolNames ?? Array.from({ length: opts.tools ?? 0 }, (_, i) => `t${i}`);
  return {
    name,
    tools: toolNames.map(() => ({}) as McpConnection["tools"][number]),
    toolNames,
    close() {},
    isOpen: () => opts.open ?? true,
    ping: opts.ping ?? (async () => {}),
  };
}

function settled(
  connections: readonly McpConnection[],
  errors: Record<string, string> = {},
): Parameters<McpStatusTracker["settle"]>[0] {
  return { connections, errors };
}

describe("McpStatusTracker", () => {
  test("before the connect settles, every configured server is connecting", async () => {
    const tracker = new McpStatusTracker(["a", "b"]);
    expect(await tracker.probe()).toEqual([
      { name: "a", state: "connecting", tools: [], moreTools: 0 },
      { name: "b", state: "connecting", tools: [], moreTools: 0 },
    ]);
  });

  test("reports each state in config order, with tools, latency and errors", async () => {
    const tracker = new McpStatusTracker(["ok", "broken", "dead", "wedged"], () => 0);
    tracker.settle(
      settled(
        [
          fakeConnection("wedged", { ping: () => Promise.reject(new Error("ping timed out")) }),
          fakeConnection("dead", { tools: 2, open: false }),
          fakeConnection("ok", { tools: 3 }),
        ],
        { broken: "spawn ENOENT" },
      ),
    );
    expect(await tracker.probe()).toEqual([
      { name: "ok", state: "connected", tools: ["t0", "t1", "t2"], moreTools: 0, latencyMs: 0 },
      { name: "broken", state: "failed", tools: [], moreTools: 0, error: "spawn ENOENT" },
      {
        name: "dead",
        state: "closed",
        tools: ["t0", "t1"],
        moreTools: 0,
        error: "the server process exited",
      },
      {
        name: "wedged",
        state: "unresponsive",
        tools: [],
        moreTools: 0,
        error: "ping timed out",
      },
    ]);
  });

  test("a closed server is not pinged", async () => {
    let pinged = false;
    const tracker = new McpStatusTracker(["dead"]);
    tracker.settle(
      settled([
        fakeConnection("dead", {
          open: false,
          ping: async () => {
            pinged = true;
          },
        }),
      ]),
    );
    await tracker.probe();
    expect(pinged).toBe(false);
  });

  test("pings run in parallel (two 40 ms pings take < 80 ms)", async () => {
    const slow = () => new Promise<void>((r) => setTimeout(r, 40));
    const tracker = new McpStatusTracker(["a", "b"]);
    tracker.settle(
      settled([fakeConnection("a", { ping: slow }), fakeConnection("b", { ping: slow })]),
    );
    const start = performance.now();
    await tracker.probe();
    expect(performance.now() - start).toBeLessThan(75);
  });

  test("passes its timeout to each ping", async () => {
    let seen: number | undefined;
    const tracker = new McpStatusTracker(["a"]);
    tracker.settle(
      settled([
        {
          ...fakeConnection("a"),
          ping: async (ms: number) => {
            seen = ms;
          },
        },
      ]),
    );
    await tracker.probe(123);
    expect(seen).toBe(123);
  });

  test("a whole-connect failure marks every server failed", async () => {
    const tracker = new McpStatusTracker(["a", "b"]);
    tracker.fail("boom");
    expect((await tracker.probe()).map((s) => [s.state, s.error])).toEqual([
      ["failed", "boom"],
      ["failed", "boom"],
    ]);
  });

  test("errors become one bounded line with no control characters", async () => {
    const tracker = new McpStatusTracker(["a"]);
    tracker.settle(settled([], { a: `line1\n\u001b[31mred\u0007${"x".repeat(2000)}` }));
    const [status] = await tracker.probe();
    expect(status?.error?.startsWith("line1 [31mred x")).toBe(true);
    expect(status?.error?.length).toBeLessThanOrEqual(500);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting their absence is the point
    expect(status?.error).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  test("odd config names are made wire-safe, so one can't fail the whole result (review F3)", async () => {
    const tracker = new McpStatusTracker(["", "tab\there", "x".repeat(300)]);
    const names = (await tracker.probe()).map((s) => s.name);
    expect(names).toEqual(["(unnamed)", "tab here", "x".repeat(200)]);
  });

  test("settles from a real connectMcpServers result", async () => {
    const tracker = new McpStatusTracker(["x"]);
    tracker.settle(await connectMcpServers({}));
    expect(await tracker.probe()).toEqual([
      { name: "x", state: "failed", tools: [], moreTools: 0, error: "not started" },
    ]);
  });

  test("tool names are made wire-safe: one line, ≤128 chars; an empty one is counted, not listed (docs/feat/mcp-tools-panel.md)", async () => {
    const tracker = new McpStatusTracker(["a"]);
    tracker.settle(
      settled([
        fakeConnection("a", { toolNames: ["ok", "bad\u001b[2J\nname", "", "n".repeat(200)] }),
      ]),
    );
    const [status] = await tracker.probe();
    expect(status?.tools).toEqual(["ok", "bad [2J name", "n".repeat(128)]);
    expect(status?.moreTools).toBe(1);
  });

  test("at most 128 names are reported; the rest are counted in moreTools", async () => {
    const tracker = new McpStatusTracker(["big"]);
    tracker.settle(settled([fakeConnection("big", { tools: 300 })]));
    const [status] = await tracker.probe();
    expect(status?.tools.length).toBe(128);
    expect(status?.tools[127]).toBe("t127");
    expect(status?.moreTools).toBe(172);
  });
});
