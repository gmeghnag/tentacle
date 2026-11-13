/**
 * docs/feat/app-decomposition.md S0 — the KEY-PRECEDENCE matrix of the real
 * `App`. Ink calls every `useInput` listener for each chunk (no
 * stop-propagation), so App's ONE handler encodes precedence as an ordered list
 * of layers. Each test below puts two layers in a position to claim the same
 * key and pins which one wins. A decomposition that reorders the layers (or
 * splits them across several `useInput`s) turns one of these red.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker, type PermissionRequest, type PermissionResponse } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type AppProps, type SessionController, type SessionDirectory } from "../src/App.tsx";
import type { DockJobRow } from "../src/background-list.ts";
import type { SessionActivity } from "../src/turn-feed.ts";
import { BACKGROUND_ROW, type DockTestRow } from "./subagent-row.ts";

const ESC = "\x1b";
const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ENTER = "\r";
const TAB = "\t";
const SHIFT_TAB = "\x1b[Z";
const CTRL_C = "\x03";
const CTRL_T = "\x14";
const CTRL_X = "\x18";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REQ: PermissionRequest = {
  tool: "shell",
  level: "ask",
  title: "Run a shell command",
  detail: "rm -rf build",
  input: {},
};

const JOB: DockJobRow = {
  id: "bg-3",
  command: "watch: tail -f log",
  startedAt: Date.now() - 60_000,
  status: "running",
};

interface Fake {
  readonly session: SessionController;
  /** Every prompt `send` received. */
  readonly prompts: string[];
  /** How many turns were aborted through their signal. */
  readonly aborts: () => number;
}

/**
 * A session whose turn HANGS until aborted when the prompt starts with
 * `hang`, so a test can hold a running turn and see whether a key stopped it.
 */
function fake(
  opts: {
    agents?: readonly DockTestRow[];
    jobs?: readonly DockJobRow[];
    /** Overrides (or, as `undefined`, removes) a controller method. */
    extra?: Record<string, unknown>;
  } = {},
): Fake {
  const prompts: string[] = [];
  let aborts = 0;
  const session = {
    async *send(prompt: string, signal?: AbortSignal) {
      prompts.push(prompt);
      if (prompt.startsWith("hang")) {
        yield { type: "text", delta: "working" };
        await new Promise<void>((resolve) => {
          signal?.addEventListener(
            "abort",
            () => {
              aborts += 1;
              resolve();
            },
            { once: true },
          );
        });
        yield { type: "turn_end", reason: "cancelled" };
        return;
      }
      yield { type: "text", delta: `reply to ${prompt}` };
      yield { type: "turn_end", reason: "end_turn" };
    },
    enqueue: () => Promise.resolve(),
    onSubagents(listener: (rows: readonly DockTestRow[]) => void) {
      listener(opts.agents ?? []);
      return () => {};
    },
    onJobs(listener: (r: { rows: readonly DockJobRow[]; count: number }) => void) {
      const rows = opts.jobs ?? [];
      listener({ rows, count: rows.length });
      return () => {};
    },
    killJob: () => Promise.resolve({ killed: true }),
    killSubagent: () => Promise.resolve({ killed: true }),
    ownsTurn: () => true,
    cancel: () => Promise.resolve(),
    ...opts.extra,
  } as unknown as SessionController;
  return { session, prompts, aborts: () => aborts };
}

const sessionsDir = (): SessionDirectory =>
  ({
    list: () => Promise.resolve({ sessions: [] }),
    open: () => {
      throw new Error("unused");
    },
    remove: () => Promise.resolve(),
  }) as unknown as SessionDirectory;

async function mount(f: Fake, extra: Partial<AppProps> = {}) {
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
  await delay(40);
  const answers: PermissionResponse[] = [];
  const ask = async (req: PermissionRequest = REQ) => {
    void permissions.request(req, { turnId: "own-1" }).then((r) => answers.push(r));
    await delay(40);
  };
  const keys = async (...chunks: string[]) => {
    for (const c of chunks) {
      app.stdin.write(c);
      await delay(20);
    }
    await delay(30);
  };
  const frame = () => app.lastFrame() ?? "";
  return { app, answers, ask, keys, frame };
}

/** The main input's row (its draft): the LAST `❯ ` row (the palette's highlight is above it). */
const inputRow = (frame: string) =>
  (
    frame
      .split("\n")
      .filter((l) => l.startsWith("❯ "))
      .at(-1) ?? ""
  ).trimEnd();
/** The dock's pill has the keys (Ctrl+T / Down from the input). */
const PILL_FOCUSED = "enter open · esc back";

describe("S0 key precedence: the first claiming layer wins, later ones never see the key", () => {
  test("quit-confirm before permission: `n` dismisses the quit dialog, never denies the ask", async () => {
    // Two layers claim `n`: quit-confirm (dismiss) and the permission dialog
    // (deny). Quit-confirm is first (App: "so its `y` never approves an ask
    // opened meanwhile"), so only it acts.
    const f = fake({ agents: [BACKGROUND_ROW.sa1] });
    const t = await mount(f);
    await t.keys(CTRL_C);
    expect(t.frame()).toContain("(y/N)");
    await t.ask();
    await t.keys("n");
    expect(t.answers).toEqual([]);
    expect(t.frame()).not.toContain("(y/N)");
    // The dialog is still up and now owns the next key.
    await t.keys("y");
    expect(t.answers).toEqual([{ allowed: true, scope: "once" }]);
    t.app.unmount();
  });

  test("dock-owned ctrl+x (dropdown focused) reaches the dock's stop, not the send-now chord", async () => {
    const f = fake({ jobs: [JOB] });
    const t = await mount(f);
    await t.keys(DOWN, ENTER);
    await t.keys(CTRL_X);
    expect(t.frame()).toContain("ctrl+x stop · any other key cancels");
    t.app.unmount();
  });

  test("ctrl+x with the input focused is the chord's: consumed, never typed, the next key goes on", async () => {
    const f = fake();
    const t = await mount(f);
    await t.keys(CTRL_X, "a");
    expect(inputRow(t.frame())).toContain("a");
    expect(t.frame()).not.toContain("ctrl+x stop");
    t.app.unmount();
  });

  test("a bracketed paste mid-turn lands in the input; its leading ESC never aborts the turn", async () => {
    const f = fake();
    const t = await mount(f);
    await t.keys("hang", ENTER);
    expect(f.prompts).toEqual(["hang"]);
    await t.keys("\x1b[200~pasted text\x1b[201~");
    expect(f.aborts()).toBe(0);
    expect(inputRow(t.frame())).toContain("pasted text");
    // A long paste arrives in pieces: its markers alone are bare ESC sequences.
    await t.keys("\x1b[200~", " more", "\x1b[201~");
    expect(f.aborts()).toBe(0);
    expect(inputRow(t.frame())).toContain("pasted text more");
    // A real Esc still stops it (the layer below is intact).
    await t.keys(ESC);
    expect(f.aborts()).toBe(1);
    t.app.unmount();
  });

  test("Esc with an upload in flight aborts the UPLOAD, never the running turn", async () => {
    // Two layers claim `key.escape`: the upload's abort (App.tsx:4098) is above
    // the turn's (App.tsx:4105). Swapping them aborts the turn and leaves the
    // bytes half-sent — the one thing attachments-tui decision 7 forbids.
    let uploadAborted = 0;
    let turnAborts = 0;
    let raise: (activity: SessionActivity) => void = () => {};
    const f = fake({
      extra: {
        imageInput: () => ({ kind: "upload" as const, maxBytes: 4 * 1024 * 1024 }),
        attachImage: (_bytes: Uint8Array, _meta: unknown, o?: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            o?.signal?.addEventListener(
              "abort",
              () => {
                uploadAborted += 1;
                reject(Object.assign(new Error("aborted"), { name: "UploadAbortedError" }));
              },
              { once: true },
            );
          }),
        // A turn raised from OUTSIDE (another device's), so one runs while the
        // upload is in flight — the only state in which both layers claim Esc.
        watch(listener: (activity: SessionActivity) => void) {
          raise = listener;
          return () => {};
        },
      },
    });
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const t = await mount(f, {
      home: "/home/u",
      localCwd: "/work",
      fileProbe: {
        read: async (path: string) =>
          path === "/tmp/a.png" ? { kind: "file", size: png.length, bytes: png } : null,
      },
    });
    await t.keys("\x1b[200~/tmp/a.png\x1b[201~");
    await delay(80);
    // Enter uploads; the prompt is sent when the upload settles.
    await t.keys(ENTER);
    await delay(60);
    // Another device's turn now runs while the bytes are still going up.
    raise({
      kind: "turn",
      turnId: "other-1",
      cancel: () => {
        turnAborts += 1;
      },
      events: (async function* () {
        await new Promise<void>((resolve) => setTimeout(resolve, 400));
        yield { type: "turn_end", reason: "end_turn" as const };
      })(),
    });
    await delay(60);
    expect(t.frame()).toContain("Working…");
    await t.keys(ESC);
    // The FIRST Esc is the upload's: the bytes are stopped, the turn is not.
    expect(uploadAborted).toBe(1);
    expect(turnAborts).toBe(0);
    // With nothing left uploading, the NEXT Esc is the turn's (the layer below
    // is intact, not merely shadowed).
    await t.keys(ESC);
    expect(turnAborts).toBe(1);
    expect(uploadAborted).toBe(1);
    t.app.unmount();
  });

  test("the sessions panel's Esc closes the panel, never stops the running turn", async () => {
    const f = fake();
    const t = await mount(f, { sessions: sessionsDir() });
    await t.keys("hang", ENTER);
    await t.keys("/sessions", ENTER);
    await delay(30);
    expect(t.frame()).toContain("sessions");
    const opened = t.frame();
    await t.keys(ESC);
    expect(f.aborts()).toBe(0);
    expect(t.frame()).not.toBe(opened);
    await t.keys(ESC);
    expect(f.aborts()).toBe(1);
    t.app.unmount();
  });

  test("the dock's Esc closes the dropdown, never stops the running turn", async () => {
    const f = fake({ agents: [BACKGROUND_ROW.sa1] });
    const t = await mount(f);
    await t.keys("hang", ENTER);
    expect(t.frame()).not.toContain(PILL_FOCUSED);
    await t.keys(CTRL_T, ENTER);
    expect(t.frame()).toContain("find callers of parseConfig");
    await t.keys(ESC);
    expect(f.aborts()).toBe(0);
    expect(t.frame()).not.toContain("find callers of parseConfig");
    // Esc in the dropdown goes back to the pill; the pill's Esc is the dock's too.
    expect(t.frame()).toContain(PILL_FOCUSED);
    await t.keys(ESC);
    expect(f.aborts()).toBe(0);
    expect(t.frame()).not.toContain(PILL_FOCUSED);
    // Back in the input, Esc reaches the abort layer.
    await t.keys(ESC);
    expect(f.aborts()).toBe(1);
    t.app.unmount();
  });

  test("palette arrows move the selection, never recall history", async () => {
    const f = fake();
    const t = await mount(f);
    await t.keys("first prompt", ENTER);
    await delay(30);
    await t.keys("/");
    await t.keys(UP);
    expect(inputRow(t.frame())).not.toContain("first prompt");
    // Up wrapped to the LAST command; Tab completes the highlighted name.
    await t.keys(TAB);
    expect(inputRow(t.frame())).toBe("❯ /exit");
    t.app.unmount();
  });

  test("palette Down + Tab completes the second command; Esc dismisses (resets the field)", async () => {
    const f = fake();
    const t = await mount(f);
    await t.keys("/", DOWN, TAB);
    expect(inputRow(t.frame())).toBe("❯ /clear");
    // A full name closes the palette; back to a prefix, Esc dismisses it.
    await t.keys("\x7f", "\x7f", "\x7f", "\x7f");
    expect(inputRow(t.frame())).toBe("❯ /c");
    await t.keys(ESC);
    expect(inputRow(t.frame())).toBe("❯  Type a task or /command");
    expect(t.frame()).not.toContain("clear the transcript");
    t.app.unmount();
  });

  test("palette Enter runs the highlighted command", async () => {
    const f = fake();
    const t = await mount(f);
    await t.keys("/mod", ENTER);
    expect(t.frame()).toContain("Model: m");
    expect(f.prompts).toEqual([]);
    t.app.unmount();
  });

  test("ctrl+t from the input toggles the dock list; with nothing running it says so", async () => {
    const empty = fake();
    const a = await mount(empty);
    await a.keys(CTRL_T);
    expect(a.frame()).toContain("Nothing is running in the background.");
    a.app.unmount();

    const busy = fake({ agents: [BACKGROUND_ROW.sa1] });
    const b = await mount(busy);
    expect(b.frame()).not.toContain(PILL_FOCUSED);
    await b.keys(CTRL_T);
    expect(b.frame()).toContain(PILL_FOCUSED);
    await b.keys(CTRL_T);
    expect(b.frame()).not.toContain(PILL_FOCUSED);
    b.app.unmount();
  });

  test("shift+tab toggles auto-accept first: over the palette and over the quit dialog", async () => {
    const f = fake({ agents: [BACKGROUND_ROW.sa1] });
    const t = await mount(f);
    expect(t.frame()).toContain("auto-accept off");
    await t.keys("/", SHIFT_TAB);
    expect(t.frame()).toContain("auto-accept on");
    // The palette's Tab did not run: the field is still the bare "/".
    expect(inputRow(t.frame())).toBe("❯ /");
    await t.keys(ESC, CTRL_C);
    expect(t.frame()).toContain("(y/N)");
    await t.keys(SHIFT_TAB);
    expect(t.frame()).toContain("auto-accept off");
    // The quit dialog was not answered by it.
    expect(t.frame()).toContain("(y/N)");
    t.app.unmount();
  });

  test("shift+tab over a pending ask approves it (auto-accept on)", async () => {
    const f = fake();
    const t = await mount(f);
    await t.ask();
    await t.keys(SHIFT_TAB);
    expect(t.answers).toEqual([{ allowed: true, scope: "once" }]);
    expect(t.frame()).toContain("auto-accept on");
    t.app.unmount();
  });

  test("shift+tab mid-turn toggles auto-accept, never stops the turn", async () => {
    // The layer is checked FIRST, "in any state (idle, running, …)": a running
    // turn is the state where a Tab could otherwise reach the palette/history.
    const f = fake();
    const t = await mount(f);
    await t.keys("hang", ENTER);
    expect(f.prompts).toEqual(["hang"]);
    expect(t.frame()).toContain("auto-accept off");
    await t.keys(SHIFT_TAB);
    expect(t.frame()).toContain("auto-accept on");
    await t.keys(SHIFT_TAB);
    expect(t.frame()).toContain("auto-accept off");
    expect(f.aborts()).toBe(0);
    t.app.unmount();
  });
});

describe("S0 uncovered key clusters (pinned before the move)", () => {
  const CTRL_V = "\x16";
  /** Ctrl+T then Enter: the dropdown, its first row selected; ctrl+x twice stops it. */
  const stopFirstRow = [CTRL_T, ENTER, CTRL_X, CTRL_X];

  test("dock stop on a CHILD goes to killSubagent; not-running, failure and no seam each say so", async () => {
    const killed: string[] = [];
    const a = await mount(
      fake({
        agents: [BACKGROUND_ROW.sa1],
        extra: {
          killSubagent: (id: string) => {
            killed.push(id);
            return Promise.resolve({ killed: false });
          },
        },
      }),
    );
    await a.keys(...stopFirstRow);
    expect(killed).toEqual(["sa-1"]);
    expect(a.frame()).toContain("sa-1 was not running any more: nothing was stopped");
    a.app.unmount();

    const b = await mount(
      fake({
        agents: [BACKGROUND_ROW.sa1],
        extra: { killSubagent: () => Promise.reject(new Error("link down")) },
      }),
    );
    await b.keys(...stopFirstRow);
    expect(b.frame()).toContain("sa-1 was not stopped: link down");
    b.app.unmount();

    const c = await mount(
      fake({ agents: [BACKGROUND_ROW.sa1], extra: { killSubagent: undefined } }),
    );
    await c.keys(...stopFirstRow);
    expect(c.frame()).toContain(
      "this session cannot stop background sub-agents: no agent kill here",
    );
    c.app.unmount();
  });

  test("dock stop on a JOB goes to killJob; not-running, failure and no seam each say so", async () => {
    const killed: string[] = [];
    const a = await mount(
      fake({
        jobs: [JOB],
        extra: {
          killJob: (id: string) => {
            killed.push(id);
            return Promise.resolve({ killed: false });
          },
        },
      }),
    );
    await a.keys(...stopFirstRow);
    expect(killed).toEqual(["bg-3"]);
    expect(a.frame()).toContain("bg-3 was not running any more: nothing was stopped");
    a.app.unmount();

    const b = await mount(
      fake({ jobs: [JOB], extra: { killJob: () => Promise.reject(new Error("gone")) } }),
    );
    await b.keys(...stopFirstRow);
    expect(b.frame()).toContain("bg-3 was not stopped: gone");
    b.app.unmount();

    const c = await mount(fake({ jobs: [JOB], extra: { killJob: undefined } }));
    await c.keys(...stopFirstRow);
    expect(c.frame()).toContain("this session cannot stop background jobs: no job kill here");
    c.app.unmount();
  });

  test("permission dialog: Down selects the second choice, Enter answers it", async () => {
    const t = await mount(fake());
    await t.ask();
    await t.keys(DOWN, ENTER);
    expect(t.answers).toHaveLength(1);
    expect(t.answers[0]?.allowed).toBe(true);
    expect(t.answers[0]).not.toEqual({ allowed: true, scope: "once" });
    t.app.unmount();
  });

  test("permission reply field: Ctrl+V pastes the clipboard; a failing clipboard says so", async () => {
    const replyReq: PermissionRequest = { ...REQ, reply: { maxChars: 2000 } };
    const t = await mount(fake(), { paste: () => Promise.resolve("from the clipboard") });
    await t.ask(replyReq);
    await t.keys("t", CTRL_V);
    await t.keys(ENTER);
    expect(t.answers).toHaveLength(1);
    expect(t.answers[0]?.allowed).toBe(false);
    expect(t.answers[0]?.message).toBe("from the clipboard");
    t.app.unmount();

    const u = await mount(fake(), { paste: () => Promise.reject(new Error("no")) });
    await u.ask(replyReq);
    await u.keys("t", CTRL_V);
    expect(u.frame()).toContain("Clipboard unavailable.");
    expect(u.answers).toEqual([]);
    u.app.unmount();
  });

  test("a complete mouse report + a trailing half one: the half is held, never typed", async () => {
    const t = await mount(fake());
    await t.keys("\x1b[<64;10;5M\x1b[<6", "5;10;5M", "z");
    expect(inputRow(t.frame())).toBe("❯ z");
    t.app.unmount();
  });

  test("an unbracketed (typed) image path + Enter becomes a chip and sends nothing", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const f = fake({
      extra: { imageInput: () => ({ kind: "upload" as const, maxBytes: 4 * 1024 * 1024 }) },
    });
    const t = await mount(f, {
      home: "/home/u",
      localCwd: "/work",
      fileProbe: {
        read: async (path: string) =>
          path === "/tmp/a.png" ? { kind: "file", size: png.length, bytes: png } : null,
      },
    });
    await t.keys("/tmp/a.png", ENTER);
    await delay(60);
    expect(f.prompts).toEqual([]);
    expect(t.frame()).toContain("📎 a.png");
    t.app.unmount();
  });
});
