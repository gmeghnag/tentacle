/**
 * The `/mcp` switches in the live App (docs/feat/session-capabilities.md S4): Space
 * sends `session/set_capability` through the controller, and the row flips on the
 * daemon's ECHO (never optimistically); another device's change is a notice; the
 * status bar marks what is off. The decisions are `capability-toggles.ts`'s (its
 * own suite); this pins the wiring, frame by frame.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";
import type { SessionController } from "../src/app-types.ts";
import type { CapOp, CapsView } from "../src/capability-toggles.ts";
import type { McpServerView } from "../src/mcp-panel.ts";
import { inertSession } from "./session-stub.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const DOWN = "\u001B[B";

const SERVERS: McpServerView[] = [
  { name: "github", state: "connected", tools: ["create_issue"], moreTools: 0, latencyMs: 4 },
  { name: "k8s", state: "connected", tools: ["get_pods", "logs"], moreTools: 0, latencyMs: 9 },
];

/** A session whose switches the test drives like a daemon: `echo` is its broadcast. */
function capsSession(opts: { opened?: boolean; caps?: CapsView; fail?: Error } = {}) {
  let state: CapsView | undefined = opts.caps ?? { disabledMcp: [], disabledSkills: [] };
  const listeners = new Set<(caps: CapsView | undefined, by?: string) => void>();
  const sets: CapOp[] = [];
  const answers: (() => void)[] = [];
  const echo = (next: CapsView | undefined, by?: string): void => {
    state = next;
    for (const l of [...listeners]) l(next, by);
  };
  const session: SessionController = {
    ...inertSession(),
    // A session that is never prompted here.
    async *send() {},
    capabilities: () => state,
    onCapabilities: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setCapability: (kind, name, enabled) => {
      sets.push({ kind, name, enabled });
      if (opts.fail) return Promise.reject(opts.fail);
      return new Promise((resolve) => {
        answers.push(() => resolve(state));
      });
    },
    opened: () => opts.opened ?? true,
  };
  return { session, sets, echo, answers, listeners };
}

async function openMcp(session: SessionController) {
  const r = render(
    <App
      createSession={() => session}
      model="qwen3"
      cwd="/tmp/work"
      mcpStatus={async () => SERVERS}
    />,
  );
  await delay(30);
  r.stdin.write("/mcp");
  await delay(30);
  r.stdin.write("\r");
  await delay(60);
  return r;
}

describe("/mcp on/off in the App (docs/feat/session-capabilities.md S4)", () => {
  test("Space sends the switch; the row flips on the daemon's echo, the bar marks it, no notice for my own", async () => {
    const d = capsSession();
    const { stdin, lastFrame, unmount } = await openMcp(d.session);
    let frame = lastFrame() ?? "";
    expect(frame).toContain("this session · applies to the next model call");
    expect(frame).toContain("❯ ▸ [✓] github  ● 1 tool");
    expect(frame).toContain("  ▸ [✓] k8s     ● 2 tools");
    expect(frame).toContain("space on/off · ↑↓ select · enter expand · esc close");

    stdin.write(DOWN);
    await delay(30);
    stdin.write(" ");
    await delay(30);
    expect(d.sets).toEqual([{ kind: "mcp", name: "k8s", enabled: false }]);
    // Not optimistic: the daemon has not echoed yet, so the row still says on.
    frame = lastFrame() ?? "";
    expect(frame).toContain("❯ ▸ [✓] k8s");
    expect(frame).not.toContain("⊘");

    d.echo({ disabledMcp: ["k8s"], disabledSkills: [] }, "this-mac");
    await delay(30);
    frame = lastFrame() ?? "";
    expect(frame).toContain("❯ ▸ [ ] k8s     ● 2 tools");
    expect(frame).toContain("⊘ 1 server off");
    expect(frame).not.toContain("turned off on"); // my own echo is not news
    for (const answer of d.answers) answer();
    await delay(10);

    // Space again: back on.
    stdin.write(" ");
    await delay(30);
    expect(d.sets.at(-1)).toEqual({ kind: "mcp", name: "k8s", enabled: true });
    unmount();
  });

  test("another device's change flips the row and says so in the transcript", async () => {
    const d = capsSession();
    const { lastFrame, unmount } = await openMcp(d.session);
    d.echo({ disabledMcp: ["github"], disabledSkills: [] }, "iPhone");
    await delay(30);
    const frame = lastFrame() ?? "";
    expect(frame).toContain(
      "MCP server github turned off on iPhone · applies to the next model call",
    );
    expect(frame).toContain("❯ ▸ [ ] github");
    expect(d.sets).toEqual([]);
    unmount();
  });

  test("before the session opens: no switch column, and Space says when it will work (nothing sent)", async () => {
    const d = capsSession({ opened: false });
    d.echo(undefined); // nothing reported yet: no daemon has opened it

    const { stdin, lastFrame, unmount } = await openMcp(d.session);
    let frame = lastFrame() ?? "";
    expect(frame).toContain("on/off after the first message");
    expect(frame).toContain("❯ ▸ github  ● 1 tool");
    stdin.write(" ");
    await delay(30);
    frame = lastFrame() ?? "";
    expect(d.sets).toEqual([]);
    expect(frame).toContain("send a first message, then try again");
    unmount();
  });

  test("a refused switch says why, and the row stays as the daemon reported it", async () => {
    const d = capsSession({ fail: new Error("too many names") });
    const { stdin, lastFrame, unmount } = await openMcp(d.session);
    stdin.write(" ");
    await delay(30);
    const frame = lastFrame() ?? "";
    expect(d.sets).toEqual([{ kind: "mcp", name: "github", enabled: false }]);
    expect(frame).toContain("Could not turn github off: too many names");
    expect(frame).toContain("❯ ▸ [✓] github");
    unmount();
  });

  test("leaving the session drops its subscription (unmount)", async () => {
    const d = capsSession();
    const { unmount } = await openMcp(d.session);
    expect(d.listeners.size).toBe(1);
    unmount();
    await delay(10);
    expect(d.listeners.size).toBe(0);
  });
});
