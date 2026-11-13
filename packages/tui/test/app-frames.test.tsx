/**
 * docs/feat/app-decomposition.md S0 — the FRAME SET of the real `App`: the
 * whole `lastFrame()` of each state a user sees, pinned as text. A later slice
 * that moves the derived rows / JSX (S10) must reproduce every frame exactly.
 * Only the volatile parts are normalised: the spinner glyph and elapsed times.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker, type PermissionRequest } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type AppProps, type SessionController, type SessionDirectory } from "../src/App.tsx";
import type { FileProbe } from "../src/attach-files.ts";
import type { DockJobRow } from "../src/background-list.ts";
import { BACKGROUND_ROW, type DockTestRow } from "./subagent-row.ts";

const ENTER = "\r";
const DOWN = "\x1b[B";
const CTRL_C = "\x03";
const CTRL_T = "\x14";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Spinner glyph → `*`; elapsed figures (`0s`, `1m 12s`, `4m`) → `N<unit>`; a run
 * of box-drawing rule (3+ `─`) → `…`. The last one is not cosmetic: a header's
 * rule is padded to the terminal width using the UN-normalised elapsed text, so
 * the wall clock crossing a digit boundary (`9s` → `10s`) shifts one dash and
 * flakes the pin on an otherwise identical frame. The filler's LENGTH is not the
 * property under test — the content either side of it is — so it is elided and
 * marked as such. Single `─` glyphs (bracket edges) are untouched.
 */
const norm = (frame: string): string =>
  frame
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g, "*")
    .replace(/\b\d+(m|s|h)\b/g, "N$1")
    .replace(/─{3,}/g, "…");

/**
 * Bun's inline snapshot. The pinned `bun-types` predates its typing, so it is
 * declared here (it exists at runtime; same pattern as `clock` in app.test.tsx).
 * The literal is the pinned frame: a mismatch fails, nothing is rewritten.
 */
const pin = (frame: string) =>
  expect(frame) as unknown as { toMatchInlineSnapshot(snapshot?: string): void };

const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0,
  0,
]);
const probe: FileProbe = {
  read: async (path: string) =>
    path === "/tmp/a.png" ? { kind: "file", size: PNG.length, bytes: PNG } : null,
};

const JOB: DockJobRow = {
  id: "bg-3",
  command: "watch: tail -f log",
  startedAt: Date.now() - 60_000,
  status: "running",
};

function fake(
  opts: { agents?: readonly DockTestRow[]; jobs?: readonly DockJobRow[] } = {},
): SessionController {
  return {
    async *send(prompt: string, signal?: AbortSignal) {
      yield { type: "text", delta: `reply to ${prompt}` };
      if (prompt.startsWith("hang")) {
        await new Promise<void>((resolve) =>
          signal?.addEventListener("abort", () => resolve(), { once: true }),
        );
      }
      yield { type: "turn_end", reason: "end_turn" };
    },
    onSubagents(listener: (rows: readonly DockTestRow[]) => void) {
      listener(opts.agents ?? []);
      return () => {};
    },
    onJobs(listener: (r: { rows: readonly DockJobRow[]; count: number }) => void) {
      const rows = opts.jobs ?? [];
      listener({ rows, count: rows.length });
      return () => {};
    },
    jobOutput: (jobId: string) =>
      Promise.resolve({
        found: true,
        jobId,
        status: "running",
        output: ["line"],
        truncated: false,
      }),
    imageInput: () => ({ kind: "upload" as const, maxBytes: 4 * 1024 * 1024 }),
    ownsTurn: () => true,
  } as unknown as SessionController;
}

async function mount(session: SessionController, props: Partial<AppProps> = {}) {
  const permissions = new PermissionBroker();
  const app = render(
    <App
      createSession={() => session}
      permissions={permissions}
      model="m"
      cwd="/tmp/work"
      fileProbe={probe}
      home="/home/u"
      localCwd="/work"
      {...props}
    />,
  );
  await delay(40);
  const keys = async (...chunks: string[]) => {
    for (const c of chunks) {
      app.stdin.write(c);
      await delay(25);
    }
    await delay(60);
  };
  const frame = () => norm(app.lastFrame() ?? "");
  return { app, permissions, keys, frame };
}

describe("S0 frame set", () => {
  test("idle", async () => {
    const t = await mount(fake());
    pin(t.frame()).toMatchInlineSnapshot(`
      "⏺ Tentacle ready. Type a task, or /help for commands.


















      … m ─
      ❯  Type a task or /command
      …
      /tmp/work · ctx –/128k                                               ⏵⏵ auto-accept off (shift+tab)"
    `);
    t.app.unmount();
  });

  test("running", async () => {
    const t = await mount(fake());
    await t.keys("hang", ENTER);
    pin(t.frame()).toMatchInlineSnapshot(`
      "⏺ Tentacle ready. Type a task, or /help for commands.

      › hang

      ⏺ reply to hang













      * Working… Ns · esc/ctrl+c to stop
      … m ─
      ❯  Queue a task…
      …
      /tmp/work · ctx –/128k                                               ⏵⏵ auto-accept off (shift+tab)"
    `);
    t.app.unmount();
  });

  test("permission dialog", async () => {
    const t = await mount(fake());
    const req: PermissionRequest = {
      tool: "shell",
      level: "ask",
      title: "Run a shell command",
      detail: "rm -rf build",
      input: {},
    };
    void t.permissions.request(req, { turnId: "own-1" });
    await delay(60);
    pin(t.frame()).toMatchInlineSnapshot(`
      "⏺ Tentacle ready. Type a task, or /help for commands.














      ╭─ Run a shell command …
       rm -rf build
       /tmp/work · writes limited to here + allowed dirs
      ❯ Yes
        Yes, and don't ask again this session
        No
       ↑↓ choose · enter confirm · y/a/n · esc deny
      /tmp/work · ctx –/128k                                               ⏵⏵ auto-accept off (shift+tab)"
    `);
    t.app.unmount();
  });

  test("palette open", async () => {
    const t = await mount(fake());
    await t.keys("/");
    pin(t.frame()).toMatchInlineSnapshot(`
      "⏺ Tentacle ready. Type a task, or /help for commands.










      ❯ /help      show this help
        /clear     clear the transcript and start a fresh session
        /compact   summarise the conversation to free up context
        /rename    rename this session (the title every device shows)
        /sessions  list this daemon's sessions and switch
        /close     end this session and quit
        /model     show the active model
        /retry     re-send the last prompt
      … m ─
      ❯ /
      …
      /tmp/work · ctx –/128k                                               ⏵⏵ auto-accept off (shift+tab)"
    `);
    t.app.unmount();
  });

  test("sessions panel (empty list)", async () => {
    const sessions = {
      list: () => Promise.resolve({ sessions: [] }),
      open: () => {
        throw new Error("unused");
      },
      remove: () => Promise.resolve(),
    } as unknown as SessionDirectory;
    const t = await mount(fake(), { sessions });
    await t.keys("/sessions", ENTER);
    pin(t.frame()).toMatchInlineSnapshot(`
      "⏺ Tentacle ready. Type a task, or /help for commands.


















      ╭─ Sessions …
        No sessions on this daemon.
       esc close
      /tmp/work · ctx –/128k                                               ⏵⏵ auto-accept off (shift+tab)"
    `);
    t.app.unmount();
  });

  test("mcp panel (no servers)", async () => {
    const t = await mount(fake(), { mcpStatus: () => Promise.resolve([]) });
    await t.keys("/mcp", ENTER);
    pin(t.frame()).toMatchInlineSnapshot(`
      "⏺ Tentacle ready. Type a task, or /help for commands.


















      ╭─ MCP servers …
        No MCP servers on this daemon.
       esc close
      /tmp/work · ctx –/128k                                               ⏵⏵ auto-accept off (shift+tab)"
    `);
    t.app.unmount();
  });

  test("skills panel (no skills)", async () => {
    const t = await mount(fake());
    await t.keys("/skills", ENTER);
    pin(t.frame()).toMatchInlineSnapshot(`
      "⏺ Tentacle ready. Type a task, or /help for commands.


















      ╭─ Skills …
        No skills on this daemon.
       esc close
      /tmp/work · ctx –/128k                                               ⏵⏵ auto-accept off (shift+tab)"
    `);
    t.app.unmount();
  });

  test("dock: pill focused, dropdown open, a child's drawer", async () => {
    const t = await mount(fake({ agents: [BACKGROUND_ROW.sa1, BACKGROUND_ROW.sa2], jobs: [JOB] }));
    await t.keys(CTRL_T);
    pin(t.frame()).toMatchInlineSnapshot(`
      "⏺ Tentacle ready. Type a task, or /help for commands.


















      … m ─
      ❯  Type a task or /command
      …
      /tmp/work · ctx –/128k"
    `);
    await t.keys(ENTER);
    pin(t.frame()).toMatchInlineSnapshot(`
      "⏺ Tentacle ready. Type a task, or /help for commands.














      ─ background · 3 … enter open · ctrl+x stop · esc back ─
      › ● sa-1  explore  find callers of parseConfig        19 tools · 12k · Nm Ns
        ● sa-2           migrate config tests to bun:test   6 tools · 3.1k · Nm Ns
        ◆ bg-3  shell    watch: tail -f log                 running · Nm Ns
      …
      ❯  Type a task or /command
      …
      /tmp/work · ctx –/128k                      ⏵⏵ auto-accept off (shift+tab)  ·  2 agents · 1 shell ▴"
    `);
    await t.keys(ENTER);
    pin(t.frame()).toMatchInlineSnapshot(`
      "⏺ Tentacle ready. Type a task, or /help for commands.








      ─ sa-1 · explore · find callers of parseConfig … running · 19 tools · 12k · Nm Ns ─
        … +11 earlier
        │ fs_read packages/config/src/schema.ts
        │ fs_grep "parseConfig(" packages/
        │ fs_read packages/cli/src/wiring.ts
        │ fs_grep "loadConfig" packages/cli
        │ fs_read packages/daemon/src/session-host.ts
        │ fs_grep "parseConfig" apps/
        │ fs_read packages/config/src/index.ts
        │ shell bun test packages/config
      ─ → sa-1 · enter sends · esc back …
      ❯  Type a task or /command
      …
      /tmp/work · ctx –/128k                      ⏵⏵ auto-accept off (shift+tab)  ·  2 agents · 1 shell ▴"
    `);
    t.app.unmount();
  });

  test("dock: a job's drawer", async () => {
    const t = await mount(fake({ jobs: [JOB] }));
    await t.keys(DOWN, ENTER, ENTER);
    pin(t.frame()).toMatchInlineSnapshot(`
      "⏺ Tentacle ready. Type a task, or /help for commands.
















      ─ bg-3 · watch: tail -f log … running · Nm Ns ─
        │ line
      …
      ❯  Type a task or /command
      …
      /tmp/work · ctx –/128k                                 ⏵⏵ auto-accept off (shift+tab)  ·  1 shell ▴"
    `);
    t.app.unmount();
  });

  test("quit confirm", async () => {
    const t = await mount(fake({ agents: [BACKGROUND_ROW.sa1] }));
    await t.keys(CTRL_C);
    pin(t.frame()).toMatchInlineSnapshot(`
      "⏺ Tentacle ready. Type a task, or /help for commands.


















      …
      1 background sub-agent (sa-1) will be lost — quit? (y/N)
      …
      /tmp/work · ctx –/128k                                   ⏵⏵ auto-accept off (shift+tab)  · 1 agent ↓"
    `);
    t.app.unmount();
  });

  test("attach chip", async () => {
    const t = await mount(fake());
    await t.keys("\x1b[200~/tmp/a.png\x1b[201~");
    await delay(80);
    pin(t.frame()).toMatchInlineSnapshot(`
      "⏺ Tentacle ready. Type a task, or /help for commands.

















      … m ─
        📎 a.png 29 B
      ❯  Type a task or /command
      …
      /tmp/work · ctx –/128k                                               ⏵⏵ auto-accept off (shift+tab)"
    `);
    t.app.unmount();
  });
});
