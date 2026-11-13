/**
 * docs/feat/app-decomposition.md S0b (Fable H3) — FRESHNESS: a key handler
 * snapshot field keeps the SOURCE it reads today, so two keys delivered with NO
 * RENDER between them behave exactly as they do now.
 *
 * The window is real and measurable, not theoretical: Ink runs the handler
 * inside `batchedUpdates` (ink `build/hooks/use-input.js:89`) and React's
 * legacy-mode batch commits after the microtask queue drains, so a second
 * `stdin.write` in the SAME tick runs the handler with the PREVIOUS render's
 * closure while refs are already live — probe
 * `.tentacle/tmp/app-decomp-0b-structural/sync-probe.ts` prints
 * `chunk="b" closureState=0 ref=1`.
 *
 * H3's rule is per field: `quitConfirmRef` (`App.tsx:3477`), `stateRef.current
 * .running` (`:3770`), `panelRef.current` (`:3676`, `:4034`), `dockRef.current`
 * and `permission.readMode()` stay REF reads; `panel`, `paletteOpen`,
 * `field.value`, `commandSel` and `permission.pending` stay RENDER values. Each
 * test below fails if the field it names is "cleaned up" onto the other source,
 * because the two disagree precisely inside this window.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker, type PermissionRequest } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import type { DockTestRow } from "./subagent-row.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const ESC = "\x1b";
const ENTER = "\r";
const CTRL_C = "\x03";

/** The main input's row: the LAST `❯ ` row that is not a menu/dialog line. */
const inputRow = (frame: string) =>
  (
    strip(frame)
      .split("\n")
      .filter((line) => line.startsWith("❯ ") && !line.includes("Yes"))
      .at(-1) ?? ""
  ).trimEnd();

const REQ: PermissionRequest = {
  tool: "shell",
  level: "ask",
  title: "Run a shell command",
  detail: "rm -rf build",
  input: {},
};

interface Fake {
  readonly session: SessionController;
  readonly prompts: string[];
  /**
   * How many of this session's turns were ABORTED after their stream began.
   * An abort raised in the same tick as the send can land before the generator
   * body's listener exists, so the count is observed from inside the body
   * (probe `.tentacle/tmp/app-decomp-0b-structural/probe-pair1.ts`).
   */
  readonly stopped: string[];
}

/** A turn that streams one row, then hangs until aborted. */
function fake(opts: { agents?: readonly DockTestRow[] } = {}): Fake {
  const prompts: string[] = [];
  const stopped: string[] = [];
  const session = {
    async *send(prompt: string, signal?: AbortSignal) {
      prompts.push(prompt);
      yield { type: "text", delta: "working" };
      if (signal?.aborted) {
        stopped.push("at-start");
      } else {
        await new Promise<void>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              stopped.push("later");
              resolve();
            },
            { once: true },
          );
        });
      }
      yield { type: "turn_end", reason: "cancelled" };
    },
    onJobs(listener: (report: { rows: readonly unknown[]; count: number }) => void) {
      listener({ rows: [], count: 0 });
      return () => {};
    },
    onSubagents(listener: (rows: readonly DockTestRow[]) => void) {
      listener(opts.agents ?? []);
      return () => {};
    },
    ownsTurn: () => true,
  } as unknown as SessionController;
  return { session, prompts, stopped };
}

function mount(f: Fake, extra: { readonly mcpStatus?: () => Promise<readonly never[]> } = {}) {
  const permissions = new PermissionBroker();
  const app = render(
    <App
      createSession={() => f.session}
      permissions={permissions}
      model="m"
      cwd="/tmp/work"
      {...extra}
    />,
  );
  return { app, permissions, frame: () => strip(app.lastFrame() ?? "") };
}

const AGENT: DockTestRow = {
  id: "sa-1",
  agentType: "explore",
  description: "find callers of parseConfig",
  state: "running",
  toolUses: 19,
  tokens: 12_400,
  startedAt: Date.now() - 72_000,
  tail: ["fs_read a.ts"],
};

describe("S0b freshness: inside one macrotask the handler sees the ref, not the render", () => {
  test("turn stop: Enter starts a turn and an Esc in the SAME tick stops that turn (`stateRef.current.running` is live)", async () => {
    const f = fake();
    const { app, frame } = mount(f);
    await delay(60);
    app.stdin.write("hang");
    await delay(60); // rendered: the field holds "hang"
    // ONE tick: the second chunk runs before React commits the first.
    app.stdin.write(ENTER);
    app.stdin.write(ESC);
    await delay(250);
    expect(f.prompts).toEqual(["hang"]);
    // The abort landed on the turn the same tick had just started. Reading the
    // render `st.running` instead leaves it running (mutation M4a → red).
    expect(f.stopped).toEqual(["at-start"]);
    expect(frame()).not.toContain("Working");
    app.unmount();
  });

  test("quit confirm: a second Ctrl+C in the SAME tick dismisses the dialog it just raised (`quitConfirmRef` is live)", async () => {
    const f = fake({ agents: [AGENT] });
    const { app, frame } = mount(f);
    await delay(80);
    // Ctrl+C asks first (a background child would be lost), then the second
    // Ctrl+C of the same tick answers it — as "No", which follows from the REF
    // already holding the dialog's facts.
    app.stdin.write(CTRL_C);
    app.stdin.write(CTRL_C);
    await delay(150);
    expect(frame()).not.toContain("(y/N)");
    // The TUI is still there (the dialog said No, nothing closed).
    expect(frame()).toContain("Tentacle ready");
    // And the pair still works once a render has happened: the next Ctrl+C asks
    // again ("never a trap"). This also proves the first dialog was really up.
    app.stdin.write(CTRL_C);
    await delay(100);
    expect(frame()).toContain("(y/N)");
    app.stdin.write("n");
    await delay(80);
    app.unmount();
  });

  test("a permission ask raised and `y` in the SAME tick: the ask is NOT approved by that key (`permission.pending` is the render value)", async () => {
    const f = fake();
    const { app, permissions, frame } = mount(f);
    await delay(60);
    const answers: unknown[] = [];
    // Raised and answered in ONE tick: no render of the dialog lies between.
    void permissions.request(REQ, { turnId: "own-1" }).then((r) => answers.push(r));
    app.stdin.write("y");
    await delay(200);
    // The dialog was not on screen when the key was parsed, so the permission
    // layer could not claim it: nothing was answered (and nothing defaulted to
    // "allow"). A slice that turned `pending` into a ref read approves here.
    expect(answers).toEqual([]);
    expect(frame()).toContain("Run a shell command");
    // The very next `y` approves it — the dialog owns the keys as soon as it is
    // rendered, so the assertion above pins the WINDOW, not a broken key.
    app.stdin.write("y");
    await delay(120);
    expect(answers).toEqual([{ allowed: true, scope: "once" }]);
    expect(frame()).not.toContain("Run a shell command");
    app.unmount();
  });

  test("a panel's Esc closes it, and an Esc in the SAME tick does not also stop the running turn (`panel` is the render value)", async () => {
    const f = fake();
    const { app, frame } = mount(f, { mcpStatus: () => Promise.resolve([]) });
    await delay(60);
    app.stdin.write("hang");
    await delay(60);
    app.stdin.write(ENTER);
    await delay(120);
    expect(frame()).toContain("Working");
    app.stdin.write("/mcp");
    await delay(40);
    app.stdin.write(ENTER);
    await delay(120);
    expect(frame()).toContain("MCP servers");
    // ONE tick: the panel's Esc and a second Esc. The panel layer reads the
    // RENDER `panel`, which this key's closure still sees as open, so it closes
    // an already-closed panel instead of falling through to the turn's Esc.
    app.stdin.write(ESC);
    app.stdin.write(ESC);
    await delay(200);
    expect(frame()).not.toContain("MCP servers");
    expect(f.stopped).toEqual([]);
    expect(frame()).toContain("Working");
    // A third Esc, with a render behind it, reaches the turn — so the assertion
    // above is about the window, not about a broken Esc.
    app.stdin.write(ESC);
    await delay(200);
    expect(frame()).not.toContain("Working");
    // The input never took either Esc as text.
    expect(inputRow(app.lastFrame() ?? "")).not.toContain("\x1b");
    app.unmount();
  });
});
