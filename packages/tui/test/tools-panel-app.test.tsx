/**
 * `/tools` in the live App (docs/feat/tool-toggles.md D7): the panel lists the
 * daemon's built-ins with `~N`, Space on a group sends ONE
 * `setCapability("tool", <group>, …)`, the row flips only on the daemon's
 * echo, an older daemon (no `disabledTools`) shows no switch, and before the
 * first message the phase is `not-open` exactly like `/mcp`.
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";
import type { SessionController } from "../src/app-types.ts";
import type { CapOp, CapsView } from "../src/capability-toggles.ts";
import type { ToolEntryView } from "../src/tools-panel.ts";
import { inertSession } from "./session-stub.ts";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const DOWN = "\u001B[B";

const TOOLS: ToolEntryView[] = [
  { name: "fs_read", tokens: 264 },
  { name: "chart", group: "visuals", tokens: 1299 },
  { name: "diagram", group: "visuals", tokens: 349 },
  { name: "skill", tokens: 40, locked: true },
];

function toolsSession(opts: { opened?: boolean; caps?: CapsView | undefined } = {}) {
  let state: CapsView | undefined =
    "caps" in opts ? opts.caps : { disabledMcp: [], disabledSkills: [], disabledTools: [] };
  const listeners = new Set<(caps: CapsView | undefined, by?: string) => void>();
  const sets: CapOp[] = [];
  const echo = (next: CapsView | undefined, by?: string): void => {
    state = next;
    for (const l of [...listeners]) l(next, by);
  };
  const session: SessionController = {
    ...inertSession(),
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
      return new Promise(() => {}); // the answer never matters: rows follow the echo
    },
    opened: () => opts.opened ?? true,
    tools: async () => ({ tools: TOOLS }),
  };
  return { session, sets, echo };
}

async function openTools(session: SessionController) {
  const r = render(<App createSession={() => session} model="qwen3" cwd="/tmp/work" />);
  await delay(30);
  r.stdin.write("/tools");
  await delay(30);
  r.stdin.write("\r");
  await delay(60);
  return r;
}

describe("/tools in the App (docs/feat/tool-toggles.md D7)", () => {
  test("rows carry ~N; Space on a group sends ONE group set; the row flips only on the echo", async () => {
    const d = toolsSession();
    const { stdin, lastFrame, unmount } = await openTools(d.session);
    let frame = lastFrame() ?? "";
    expect(frame).toContain(
      "Tools · ~1952 tokens · 0 off · this session · applies to the next model call",
    );
    expect(frame).toContain("[✓] fs_read  ~264");
    expect(frame).toContain("▸ [✓] visuals  ~1648  2 tools");
    expect(frame).toContain("[–] skill    ~40  always on");

    stdin.write(DOWN);
    await delay(30);
    stdin.write(" ");
    await delay(30);
    expect(d.sets).toEqual([{ kind: "tool", name: "visuals", enabled: false }]);
    frame = lastFrame() ?? "";
    expect(frame).toContain("❯ ▸ [✓] visuals"); // not optimistic

    d.echo(
      { disabledMcp: [], disabledSkills: [], disabledTools: ["chart", "diagram"] },
      "this-mac",
    );
    await delay(30);
    frame = lastFrame() ?? "";
    expect(frame).toContain("❯ ▸ [ ] visuals");
    expect(frame).toContain("⊘ 2 tools off");
    expect(frame).not.toContain("turned off on"); // my own group echo is not news
    unmount();
  });

  test("a partially-off group shows [~] and Space turns it ON (Q7)", async () => {
    const d = toolsSession({
      caps: { disabledMcp: [], disabledSkills: [], disabledTools: ["chart"] },
    });
    const { stdin, lastFrame, unmount } = await openTools(d.session);
    expect(lastFrame() ?? "").toContain("[~] visuals");
    stdin.write(DOWN);
    await delay(30);
    stdin.write(" ");
    await delay(30);
    expect(d.sets).toEqual([{ kind: "tool", name: "visuals", enabled: true }]);
    unmount();
  });

  test("Space on the locked skill sends nothing", async () => {
    const d = toolsSession();
    const { stdin, unmount } = await openTools(d.session);
    for (let i = 0; i < 2; i++) {
      stdin.write(DOWN);
      await delay(20);
    }
    stdin.write(" ");
    await delay(30);
    expect(d.sets).toEqual([]);
    unmount();
  });

  test("an older daemon (no disabledTools) shows no switch and an honest line; Space says so", async () => {
    const d = toolsSession({ caps: { disabledMcp: [], disabledSkills: [] } });
    const { stdin, lastFrame, unmount } = await openTools(d.session);
    let frame = lastFrame() ?? "";
    expect(frame).toContain("on/off needs a newer tentacle on this computer");
    expect(frame).toContain("fs_read  ~264");
    expect(frame).not.toContain("[✓]");
    stdin.write(" ");
    await delay(30);
    frame = lastFrame() ?? "";
    expect(d.sets).toEqual([]);
    expect(frame).toContain("Tool on/off needs a newer tentacle on this computer.");
    unmount();
  });

  test("before the first message: not-open, the same words as /mcp, nothing sent", async () => {
    const d = toolsSession({ opened: false, caps: undefined });
    const { stdin, lastFrame, unmount } = await openTools(d.session);
    let frame = lastFrame() ?? "";
    expect(frame).toContain("on/off after the first message");
    stdin.write(" ");
    await delay(30);
    frame = lastFrame() ?? "";
    expect(d.sets).toEqual([]);
    expect(frame).toContain("send a first message, then try again");
    unmount();
  });
});
