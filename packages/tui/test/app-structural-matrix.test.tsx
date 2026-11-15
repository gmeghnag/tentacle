/**
 * docs/feat/app-decomposition.md S0b (Fable H3) — the ROUTER's matrix rows the
 * S0 net did not cover. Each one pins a layer that ACTS and PASSES (or a
 * carry), which "first claimer wins" alone does not describe:
 *
 * - a chord-breaking key still does its own job (`stepChord` returns `pass`);
 * - a non-panel key on an ARMED `/sessions` row disarms AND acts
 *   (`App.tsx:3638-3641`: a panel key disarms, any other key disarms and falls
 *   through);
 * - a printable key on the FOCUSED pill types into the input AND returns the
 *   focus to it, so the next Enter sends (the owner's P3 (a); `dockKey`'s
 *   `step.state` is applied on `pass` too, `:3731-3733`);
 * - `[` + Enter: a held bare bracket is restored and the whole text submitted,
 *   not a bare Enter;
 * - a key behind a list panel after a half mouse report edits nothing.
 *
 * S3 replaces this ORDER with a 14-layer `{effects, verdict, carry}` list and S4
 * replaces the mouse chunk handling; every row here must survive both.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type AppProps, type SessionController } from "../src/App.tsx";
import type { DockJobRow } from "../src/background-list.ts";
import { inertSession } from "./session-stub.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping ANSI SGR codes
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const ESC = "\x1b";
const ENTER = "\r";
const CTRL_T = "\x14";
const CTRL_X = "\x18";

/** The main input's row: the last `❯ ` row that is not a menu/dialog line. */
const inputRow = (frame: string) =>
  (
    strip(frame)
      .split("\n")
      .filter((line) => line.startsWith("❯ ") && !line.includes("Yes"))
      .at(-1) ?? ""
  ).trimEnd();
/** Whether an input row shows a draft (the placeholder row means an empty field). */
const draft = (frame: string) => {
  const row = inputRow(frame);
  return row.startsWith("❯  ") ? "" : row.replace(/^❯ /, "");
};

const JOB: DockJobRow = {
  id: "bg-3",
  command: "watch: tail -f log",
  startedAt: Date.now() - 60_000,
  status: "running",
};

function fake(opts: { jobs?: readonly DockJobRow[] } = {}): {
  session: SessionController;
  prompts: string[];
} {
  const prompts: string[] = [];
  const session = {
    ...inertSession(),
    async *send(prompt: string) {
      prompts.push(prompt);
      yield { type: "text", delta: `reply to ${prompt}` };
      yield { type: "turn_end", reason: "end_turn" };
    },
    onJobs(listener: (r: { rows: readonly DockJobRow[]; count: number }) => void) {
      listener({ rows: opts.jobs ?? [], count: opts.jobs?.length ?? 0 });
      return () => {};
    },
    onSubagents(listener: (rows: readonly never[]) => void) {
      listener([]);
      return () => {};
    },
    ownsTurn: () => true,
  } as unknown as SessionController;
  return { session, prompts };
}

/** The /sessions directory: two rows, so a cursor move is visible. */
const directory = () =>
  ({
    list: () =>
      Promise.resolve({
        sessions: [
          {
            id: "s1",
            title: "first session",
            updatedAt: Date.now(),
            running: false,
            attached: 0,
            archived: false,
          },
          {
            id: "s2",
            title: "second session",
            updatedAt: Date.now(),
            running: false,
            attached: 0,
            archived: false,
          },
        ],
        more: false,
      }),
    open: () => {
      throw new Error("unused");
    },
    remove: () => Promise.resolve(),
  }) as unknown as AppProps["sessions"];

async function mount(f: ReturnType<typeof fake>, extra: Partial<AppProps> = {}) {
  const app = render(
    <App
      createSession={() => f.session}
      permissions={new PermissionBroker()}
      model="m"
      cwd="/tmp/work"
      mcpStatus={() => Promise.resolve([])}
      {...extra}
    />,
  );
  await delay(80);
  const frame = () => app.lastFrame() ?? "";
  const keys = async (...chunks: string[]) => {
    for (const chunk of chunks) {
      app.stdin.write(chunk);
      await delay(30);
    }
    await delay(60);
  };
  return { app, frame, keys };
}

describe("S0b router matrix: layers that act AND pass, and a carried bracket", () => {
  test("a chord-breaking key still does its own job: Ctrl+X, then `a` is typed, not swallowed", async () => {
    const f = fake();
    const t = await mount(f);
    await t.keys(CTRL_X); // arms the send-now chord
    await t.keys("a"); // breaks it — and must land in the input
    expect(draft(t.frame())).toBe("a");
    t.app.unmount();
  });

  test("a non-panel key on an ARMED /sessions row disarms AND acts: the wheel cancels the delete and scrolls", async () => {
    const f = fake();
    const t = await mount(f, { sessions: directory() });
    // Enough transcript for the wheel to move (the bar says how far it scrolled).
    for (let i = 0; i < 12; i++) {
      await t.keys(`line${i}`, ENTER);
    }
    await t.keys("/sessions", ENTER);
    expect(t.frame()).toContain("first session");
    await t.keys("x");
    // Armed: the panel asks for the confirmation instead of deleting.
    expect(t.frame()).toContain("press x again to delete first session");
    // A MOUSE report is not a panel key, so it disarms the delete and then falls
    // through to its own layer (the wheel scrolls the transcript).
    t.app.stdin.write("\u001B[<64;10;5M"); // wheel up
    await delay(150);
    const frame = t.frame();
    expect(frame).not.toContain("press x again");
    expect(frame).toMatch(/↑\d+ more/);
    // The panel is still open and the row is still there: the disarm acted on
    // the panel's own state, and the wheel acted on the transcript.
    expect(frame).toContain("first session");
    t.app.unmount();
  });

  test("a printable key on the FOCUSED pill types into the input and hands the focus back, so the next Enter SENDS", async () => {
    const f = fake({ jobs: [JOB] });
    const t = await mount(f);
    await t.keys(CTRL_T); // focus the pill
    expect(t.frame()).toContain("enter open");
    // The key that acts on the pill (`dockKey` returns `pass` with a new state:
    // the focus returns to the input) and is then typed.
    await t.keys("h");
    expect(draft(t.frame())).toBe("h");
    await t.keys("i", ENTER);
    // Enter SENT the text: with the focus left on the pill it would have opened
    // the dropdown instead and `prompts` would be empty.
    expect(f.prompts).toEqual(["hi"]);
    expect(t.frame()).not.toContain("background ·");
    t.app.unmount();
  });

  test("a held bracket plus Enter: the bracket is RESTORED and submitted with the key, not dropped", async () => {
    const f = fake();
    const t = await mount(f);
    // A bare "[" is indistinguishable from a mouse report's first half, so it is
    // held for 100 ms. Enter inside that window must carry it into the submit.
    await t.keys("[", ENTER);
    expect(f.prompts).toEqual(["["]);
    // Nothing is left behind in the input, and the bracket is not submitted twice.
    expect(draft(t.frame())).toBe("");
    t.app.unmount();
  });

  test("a held bracket plus a letter: the restored bracket precedes the letter in the same chunk", async () => {
    const f = fake();
    const t = await mount(f);
    await t.keys("[", "b");
    expect(draft(t.frame())).toBe("[b");
    expect(f.prompts).toEqual([]);
    t.app.unmount();
  });

  // Fix round 1 (M1/M4): the held-`[` TIMER is the one place in the key path
  // that runs in a FROZEN closure — `holdMouse` is memoised on `[field.insert]`,
  // so its `panel` is the mount's `null` forever, while `panelRef.current` is
  // live. The two therefore disagree only when the panel is OPEN when the timer
  // fires (measured; a panel closing inside the window does NOT discriminate,
  // because a frozen `null` and a live `null` agree). Mutant M4 replaces the ref
  // read with the render one and THIS test is what sees it.
  test("a `[` held for the mouse window is not restored while a panel is open (the timer reads the live `panelRef`)", async () => {
    const f = fake();
    const t = await mount(f);
    await t.keys("/mcp", ENTER);
    expect(t.frame()).toContain("MCP servers");
    // A bare `[` is indistinguishable from a mouse report's first half, so it is
    // HELD for 100 ms; the timer that releases it must see the panel as it is
    // NOW, not as it was when `holdMouse` was created.
    await t.keys("[");
    await delay(200); // past the hold: the timer fires with the panel still open
    expect(draft(t.frame())).toBe("");
    // Closing the panel afterwards does not resurrect the dropped bracket.
    await t.keys(ESC);
    expect(t.frame()).not.toContain("MCP servers");
    expect(draft(t.frame())).toBe("");
    t.app.unmount();
  });

  test("a bracketed paste behind an open panel never edits the hidden input", async () => {
    const f = fake();
    const t = await mount(f);
    await t.keys("/mcp", ENTER);
    expect(t.frame()).toContain("MCP servers");
    // A terminal paste arrives as ONE chunk wrapped in the paste markers.
    t.app.stdin.write("\u001b[200~PASTED\u001b[201~");
    await delay(120);
    expect(t.frame()).toContain("MCP servers"); // still the panel's frame
    await t.keys(ESC);
    expect(draft(t.frame())).toBe(""); // and the panel's text never landed
    t.app.unmount();
  });

  test("a key behind a list panel after a half mouse report edits nothing (the panel keeps the keys)", async () => {
    const f = fake();
    const t = await mount(f);
    await t.keys("/mcp", ENTER);
    expect(t.frame()).toContain("MCP servers");
    // A half report is held; the key that follows is behind the panel, so
    // nothing edits the hidden input — and the panel stays open.
    await t.keys("[<0;5", "z");
    expect(t.frame()).toContain("MCP servers");
    expect(draft(t.frame())).toBe("");
    // Esc closes it normally afterwards (the held half never resurfaced).
    await t.keys(ESC);
    expect(t.frame()).not.toContain("MCP servers");
    expect(draft(t.frame())).toBe("");
    t.app.unmount();
  });
});
