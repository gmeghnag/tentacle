/**
 * The switches before the first message, in the live App
 * (docs/feat/caps-before-first-message.md D4): a session not open yet whose
 * client reports a PREVIEW shows live switches in `/mcp`, `/skills` and `/tools`
 * ("applies from the first message"); Space flips the row at once (the client
 * emits the preview) and the status line marks it. A first message the client
 * held back (`SwitchesNotAppliedError`) withdraws its bubble and gives its text
 * back with one line.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";
import type { SessionController } from "../src/app-types.ts";
import type { CapOp, CapsView } from "../src/capability-toggles.ts";
import type { McpServerView } from "../src/mcp-panel.ts";
import type { ToolEntryView } from "../src/tools-panel.ts";
import { inertSession } from "./session-stub.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const DOWN = "\u001B[B";

const SERVERS: McpServerView[] = [
  { name: "github", state: "connected", tools: ["create_issue"], moreTools: 0, latencyMs: 4 },
];
const TOOLS: ToolEntryView[] = [
  { name: "fs_read", tokens: 264 },
  { name: "chart", group: "visuals", tokens: 1299 },
  { name: "diagram", group: "visuals", tokens: 349 },
];

/**
 * A lazy session as `RemoteSession` presents it before its open: `opened()`
 * false, `capabilities()` the preview, and a pre-open `setCapability` that
 * emits the new preview at once and stays pending (it settles at the open).
 */
function previewSession(opts: { sendError?: Error } = {}) {
  let state: CapsView = { disabledMcp: [], disabledSkills: [], disabledTools: [] };
  const listeners = new Set<(caps: CapsView | undefined, by?: string) => void>();
  const sets: CapOp[] = [];
  const toggle = (list: readonly string[] | undefined, name: string, enabled: boolean) =>
    enabled ? (list ?? []).filter((n) => n !== name) : [...(list ?? []), name];
  const session: SessionController = {
    ...inertSession(),
    async *send() {
      if (opts.sendError) throw opts.sendError;
      yield* [];
    },
    capabilities: () => state,
    onCapabilities: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setCapability: (kind, name, enabled) => {
      sets.push({ kind, name, enabled });
      const members = kind === "tool" && name === "visuals" ? ["chart", "diagram"] : [name];
      let tools = state.disabledTools;
      if (kind === "tool") for (const m of members) tools = toggle(tools, m, enabled);
      state = {
        disabledMcp: kind === "mcp" ? toggle(state.disabledMcp, name, enabled) : state.disabledMcp,
        disabledSkills:
          kind === "skill" ? toggle(state.disabledSkills, name, enabled) : state.disabledSkills,
        disabledTools: tools,
      };
      for (const l of [...listeners]) l(state);
      return new Promise(() => {}); // settles at the open, which never comes here
    },
    opened: () => false,
    tools: async () => ({ tools: TOOLS }),
  };
  return { session, sets };
}

async function openPanel(session: SessionController, command: string) {
  const r = render(
    <App
      createSession={() => session}
      model="qwen3"
      cwd="/tmp/work"
      mcpStatus={async () => SERVERS}
    />,
  );
  await delay(30);
  r.stdin.write(command);
  await delay(30);
  r.stdin.write("\r");
  await delay(60);
  return r;
}

describe("switches before the first message (docs/feat/caps-before-first-message.md D4)", () => {
  test("/mcp: a live switch column, Space flips the row at once, the bar marks it", async () => {
    // Mutation M5: `capsPhase` → `not-open` whenever `!opened` → no `[✓]`, red.
    const d = previewSession();
    const { stdin, lastFrame, unmount } = await openPanel(d.session, "/mcp");
    let frame = lastFrame() ?? "";
    expect(frame).toContain("this session · applies from the first message");
    expect(frame).toContain("[✓] github");
    stdin.write(" ");
    await delay(30);
    frame = lastFrame() ?? "";
    expect(d.sets).toEqual([{ kind: "mcp", name: "github", enabled: false }]);
    expect(frame).toContain("[ ] github");
    expect(frame).toContain("⊘ 1 server off");
    expect(frame).not.toContain("send a first message, then try again");
    unmount();
  });

  test("/tools: the same mechanism on a group (one set, both members off)", async () => {
    const d = previewSession();
    const { stdin, lastFrame, unmount } = await openPanel(d.session, "/tools");
    let frame = lastFrame() ?? "";
    expect(frame).toContain("applies from the first message");
    expect(frame).toContain("▸ [✓] visuals");
    stdin.write(DOWN);
    await delay(30);
    stdin.write(" ");
    await delay(30);
    frame = lastFrame() ?? "";
    expect(d.sets).toEqual([{ kind: "tool", name: "visuals", enabled: false }]);
    expect(frame).toContain("▸ [ ] visuals");
    unmount();
  });

  test("a first message held back: the bubble goes, the text comes back, one line says why", async () => {
    const held = new Error("a switch could not be applied: visuals off (unknown)");
    held.name = "SwitchesNotAppliedError";
    const d = previewSession({ sendError: held });
    const { stdin, lastFrame, unmount } = render(
      <App createSession={() => d.session} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("hello there");
    await delay(30);
    stdin.write("\r");
    await delay(80);
    const frame = lastFrame() ?? "";
    expect(frame).toContain("Message not sent: a switch could not be applied");
    // Once only: in the input, not also as a transcript bubble.
    expect(frame.split("hello there").length - 1).toBe(1);
    unmount();
  });
});
