import { describe, expect, test } from "bun:test";
import { DISMISSED, PermissionBroker, type PermissionResponse } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import type { DaemonQueue } from "../src/queued.ts";
import type { SessionEvent } from "../src/state.ts";
import type { SessionActivity } from "../src/turn-feed.ts";

// docs/feat/tui-foreign-turns.md step C: the App renders ANY turn of the
// session through one loop. A fake controller raises the session's activity.

const ESC = "\x1b";
const CTRL_C = "\x03";
const SHIFT_TAB = "\x1b[Z";
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rpcError = (code: number, message: string) => Object.assign(new Error(message), { code });
const TURN_IN_PROGRESS = -32004;

/** A turn's events the test drives: `push`, then `end` (no turn_end unless pushed) or `fail`. */
function stream() {
  const queue: SessionEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let error: unknown = null;
  const events: AsyncIterable<SessionEvent> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next) yield next;
        }
        if (error) throw error;
        if (done) return;
        await new Promise<void>((r) => {
          wake = r;
        });
      }
    },
  };
  const poke = (): void => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    events,
    push: (...e: SessionEvent[]) => {
      queue.push(...e);
      poke();
    },
    end: () => {
      done = true;
      poke();
    },
    fail: (e: unknown) => {
      error = e;
      poke();
    },
  };
}

function foreignTurn(turnId: string, cancels: string[]) {
  const s = stream();
  const activity: SessionActivity = {
    kind: "turn",
    turnId,
    events: s.events,
    cancel: () => cancels.push(turnId),
  };
  return { ...s, activity };
}

/**
 * A remote-like session that other devices drive too. `send("mine-lost")`
 * raises `onLost` (a foreign turn) then rejects TurnInProgress before any
 * event; any other prompt answers at once.
 */
function sharedSession(
  opts: {
    readonly onLost?: () => void;
    readonly compact?: () => Promise<{ before: number; after: number }>;
    readonly open?: () => Promise<void>;
    readonly withOwnsTurn?: boolean;
  } = {},
) {
  const log = {
    sends: [] as string[],
    enqueues: [] as string[],
    cancels: [] as string[],
    opens: 0,
    order: [] as string[],
  };
  let listener: ((a: SessionActivity) => void) | null = null;
  let queueListener: ((q: DaemonQueue) => void) | null = null;
  const ctrl: SessionController = {
    async *send(prompt) {
      log.sends.push(prompt);
      if (prompt === "mine-lost") {
        opts.onLost?.();
        await delay(10);
        throw rpcError(TURN_IN_PROGRESS, "a turn is already running");
      }
      yield { type: "text", delta: `reply to ${prompt}` };
      yield { type: "turn_end", reason: "end_turn" };
    },
    enqueue(text) {
      log.enqueues.push(text);
      return Promise.resolve();
    },
    watch(l) {
      log.order.push("watch");
      listener = l;
      return () => {
        listener = null;
      };
    },
    open() {
      log.order.push("open");
      log.opens += 1;
      return opts.open ? opts.open() : Promise.resolve();
    },
    onQueued(l) {
      queueListener = l;
      return () => {
        queueListener = null;
      };
    },
  };
  if (opts.withOwnsTurn !== false) {
    ctrl.ownsTurn = (id) => id.startsWith("own");
  }
  if (opts.compact) {
    ctrl.compact = opts.compact;
  }
  return {
    ctrl,
    log,
    raise: (a: SessionActivity) => listener?.(a),
    queue: (q: DaemonQueue) => queueListener?.(q),
  };
}

async function mount(ctrl: SessionController, extra = {}) {
  const app = render(<App createSession={() => ctrl} model="m" cwd="/tmp/work" {...extra} />);
  await delay(30);
  return app;
}

async function type(stdin: { write(d: string): void }, text: string) {
  stdin.write(text);
  await delay(20);
  stdin.write("\r");
  await delay(40);
}

describe("foreign turns in the TUI", () => {
  test("T-C1 RED: a foreign turn renders its bubble, its text and the running line; then idle", async () => {
    const s = sharedSession();
    const app = await mount(s.ctrl);
    const f = foreignTurn("F1", s.log.cancels);
    s.raise(f.activity);
    f.push({ type: "user_message", text: "theirs" }, { type: "text", delta: "streamed by them" });
    await delay(60);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("› theirs");
    expect(frame).toContain("streamed by them");
    expect(frame).toContain("working…");
    f.push({ type: "turn_end", reason: "end_turn" });
    f.end();
    await delay(60);
    expect(app.lastFrame() ?? "").not.toContain("working…");
    app.unmount();
  });

  test("T-C2: Enter during it steers it; Esc cancels it; Ctrl+C cancels the next one", async () => {
    const s = sharedSession();
    const app = await mount(s.ctrl);
    const f1 = foreignTurn("F1", s.log.cancels);
    s.raise(f1.activity);
    f1.push({ type: "user_message", text: "theirs" });
    await delay(40);
    await type(app.stdin, "more");
    expect(s.log.enqueues).toEqual(["more"]);
    expect(s.log.sends).toEqual([]); // never a prompt of mine
    app.stdin.write(ESC);
    await delay(40);
    expect(s.log.cancels).toEqual(["F1"]);
    f1.push({ type: "turn_end", reason: "cancelled" });
    f1.end();
    await delay(40);
    const f2 = foreignTurn("F2", s.log.cancels);
    s.raise(f2.activity);
    f2.push({ type: "user_message", text: "again" });
    await delay(40);
    app.stdin.write(CTRL_C);
    await delay(40);
    expect(s.log.cancels).toEqual(["F1", "F2"]);
    app.unmount();
  });

  test("T-C3 RED: Ctrl+C in a foreign turn's permission dialog cancels that turn (the dialog closes, nothing denied)", async () => {
    const s = sharedSession();
    const permissions = new PermissionBroker();
    const app = await mount(s.ctrl, { permissions });
    const f = foreignTurn("F1", s.log.cancels);
    s.raise(f.activity);
    f.push({ type: "user_message", text: "theirs" });
    await delay(40);
    const answer = permissions.request(
      { tool: "shell", level: "ask", title: "Run rm", input: {} },
      { turnId: "F1" },
    );
    await delay(40);
    expect(app.lastFrame() ?? "").toContain("Run rm");
    app.stdin.write(CTRL_C);
    await delay(40);
    expect(s.log.cancels).toEqual(["F1"]);
    expect(await answer).toEqual(DISMISSED);
    app.unmount();
  });

  test("T-C3b RED: auto-accept ON answers only my own turn's request; a foreign one and one with no turn are asked", async () => {
    // Mutation: ignore `own` in `autoApproves` → the foreign request is auto-approved.
    const s = sharedSession();
    const permissions = new PermissionBroker();
    const app = await mount(s.ctrl, { permissions });
    app.stdin.write(SHIFT_TAB);
    await delay(30);
    const req = { tool: "shell", level: "ask", title: "Run thing", input: {} } as const;
    expect(await permissions.request(req, { turnId: "own-1" })).toEqual({
      allowed: true,
      scope: "once",
    });
    const foreign: PermissionResponse[] = [];
    void permissions.request(req, { turnId: "F1" }).then((r) => foreign.push(r));
    await delay(40);
    expect(foreign).toEqual([]); // asked, not auto-approved
    expect(app.lastFrame() ?? "").toContain("Run thing");
    app.stdin.write("n");
    await delay(30);
    expect(foreign).toEqual([{ allowed: false }]);
    const none: PermissionResponse[] = [];
    void permissions.request(req).then((r) => none.push(r));
    await delay(40);
    expect(none).toEqual([]);
    app.stdin.write("n");
    await delay(30);
    expect(none).toEqual([{ allowed: false }]);
    app.unmount();
  });

  test("T-C3c: with no session that decides (a local one), auto-accept answers every request, as before", async () => {
    const s = sharedSession({ withOwnsTurn: false });
    const permissions = new PermissionBroker();
    const app = await mount(s.ctrl, { permissions });
    app.stdin.write(SHIFT_TAB);
    await delay(30);
    const req = { tool: "shell", level: "ask", title: "x", input: {} } as const;
    expect(await permissions.request(req)).toEqual({ allowed: true, scope: "once" });
    app.unmount();
  });

  test("T-C4: my prompt loses the slot → its bubble is gone, its text is back in the input, the notice; the held foreign turn renders after", async () => {
    const cancels: string[] = [];
    const f = foreignTurn("F1", cancels);
    const s = sharedSession({
      onLost: () => {
        s.raise(f.activity);
        f.push({ type: "user_message", text: "theirs" }, { type: "text", delta: "their answer" });
      },
    });
    const app = await mount(s.ctrl);
    await type(app.stdin, "mine-lost");
    await delay(60);
    const frame = app.lastFrame() ?? "";
    expect(frame).not.toContain("› mine-lost");
    expect(frame).toContain("❯ mine-lost");
    expect(frame).toContain("another device started a turn");
    expect(frame).toContain("› theirs");
    expect(frame).toContain("their answer");
    expect(frame.indexOf("another device started a turn")).toBeLessThan(frame.indexOf("› theirs"));
    f.push({ type: "turn_end", reason: "end_turn" });
    f.end();
    app.unmount();
  });

  test("T-C5: /exit during a foreign turn exits at once and cancels nothing", async () => {
    // Mutation: drop the `foreign` input to `quitAction` → it stops the turn first (a cancel).
    const s = sharedSession();
    const log: string[] = [];
    const notices = { onNotice: () => () => log.push("unmounted") };
    const app = await mount(s.ctrl, { notices });
    const f = foreignTurn("F1", s.log.cancels);
    s.raise(f.activity);
    f.push({ type: "user_message", text: "theirs" });
    await delay(40);
    await type(app.stdin, "/exit");
    await delay(40);
    expect(s.log.cancels).toEqual([]);
    expect(log).toEqual(["unmounted"]);
    app.unmount();
  });

  test("T-C6: the rows are the daemon's list (a phone's row shows) + my unacked row; a foreign steer keeps mine; mine carried stay visible", async () => {
    const s = sharedSession();
    let ack = (): void => {};
    let myId = "";
    s.ctrl.enqueue = (text, id) => {
      s.log.enqueues.push(text);
      myId = id ?? "";
      return new Promise<void>((r) => {
        ack = r;
      });
    };
    const app = await mount(s.ctrl);
    const f = foreignTurn("F1", s.log.cancels);
    s.raise(f.activity);
    f.push({ type: "user_message", text: "theirs" });
    await delay(40);
    s.queue({ entries: [{ id: "p1", text: "phone row" }] });
    await delay(30);
    expect(app.lastFrame() ?? "").toContain("phone row");
    await type(app.stdin, "my row");
    let frame = app.lastFrame() ?? "";
    expect(frame).toContain("phone row");
    expect(frame).toContain("my row"); // not acked yet: still shown locally
    // Acked: the daemon lists both rows.
    s.queue({
      entries: [
        { id: "p1", text: "phone row" },
        { id: myId, text: "my row" },
      ],
    });
    ack();
    await delay(20);
    // The phone's row is drained (a foreign steer): my row stays.
    f.push({ type: "steer", text: "phone row", id: "p1" });
    s.queue({ entries: [{ id: myId, text: "my row" }] });
    await delay(40);
    frame = app.lastFrame() ?? "";
    // Once: the injected steer's bubble in the transcript, no longer a queued row.
    expect(frame.split("phone row").length - 1).toBe(1);
    expect(frame).toContain("my row");
    // That turn ends (another device's send-now carries my row into its turn):
    // my local rows go at the end, the daemon's list still shows mine.
    f.push({ type: "turn_end", reason: "cancelled" });
    f.end();
    await delay(30);
    const g = foreignTurn("F2", s.log.cancels);
    s.raise(g.activity);
    g.push({ type: "user_message", text: "phone now" });
    await delay(40);
    expect(app.lastFrame() ?? "").toContain("my row");
    app.unmount();
  });

  test("T-C6b: no daemon report → the local rows only, as before", async () => {
    const s = sharedSession();
    const app = await mount(s.ctrl);
    const f = foreignTurn("F1", s.log.cancels);
    s.raise(f.activity);
    f.push({ type: "user_message", text: "theirs" });
    await delay(40);
    await type(app.stdin, "local row");
    expect(app.lastFrame() ?? "").toContain("local row");
    app.unmount();
  });

  test("T-C7: closed / deleted on another device → the notice", async () => {
    const s = sharedSession();
    const app = await mount(s.ctrl);
    s.raise({ kind: "closed", reason: "closed" });
    await delay(30);
    expect(app.lastFrame() ?? "").toContain("this session was closed on another device");
    s.raise({ kind: "closed", reason: "deleted" });
    await delay(30);
    expect(app.lastFrame() ?? "").toContain("this session was deleted on another device");
    app.unmount();
  });

  test("T-C9: another device's send-now on my compaction → my rows back in the input; the foreign turn renders", async () => {
    let settle: (e: unknown) => void = () => {};
    const s = sharedSession({
      compact: () =>
        new Promise((_, reject) => {
          settle = reject;
        }),
    });
    const app = await mount(s.ctrl);
    await type(app.stdin, "/compact");
    await type(app.stdin, "row A");
    const f = foreignTurn("F1", s.log.cancels);
    s.raise(f.activity); // consumed at once: no run of mine streams
    f.push({ type: "user_message", text: "their now" });
    await delay(40);
    settle(rpcError(-32010, "compaction cancelled"));
    await delay(60);
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("› their now");
    expect(frame).toContain("❯ row A");
    expect(s.log.sends).toEqual([]); // the rows were never sent by themselves
    app.unmount();
  });

  test("T-C10: a foreign stream that closes with no turn_end → idle", async () => {
    const s = sharedSession();
    const app = await mount(s.ctrl);
    const f = foreignTurn("F1", s.log.cancels);
    s.raise(f.activity);
    f.push({ type: "user_message", text: "theirs" });
    await delay(40);
    expect(app.lastFrame() ?? "").toContain("working…");
    f.end();
    await delay(40);
    expect(app.lastFrame() ?? "").not.toContain("working…");
    app.unmount();
  });

  test("T-C11: an idle compaction not mine keeps the transcript + notice; mine adds no extra notice; any other history replaces it", async () => {
    const s = sharedSession({ compact: async () => ({ before: 9, after: 2 }) });
    const app = await mount(s.ctrl);
    await type(app.stdin, "hello");
    s.raise({ kind: "history", messages: [{ role: "user", content: "summary" }], compacted: true });
    await delay(30);
    let frame = app.lastFrame() ?? "";
    expect(frame).toContain("› hello");
    expect(frame).toContain("compacted on another device");
    await type(app.stdin, "/compact");
    s.raise({ kind: "history", messages: [{ role: "user", content: "summary" }], compacted: true });
    await delay(30);
    frame = app.lastFrame() ?? "";
    expect(frame.split("compacted on another device").length - 1).toBe(1);
    expect(frame).toContain("› hello");
    s.raise({
      kind: "history",
      messages: [{ role: "user", content: "the daemon's" }],
      compacted: false,
    });
    await delay(30);
    frame = app.lastFrame() ?? "";
    expect(frame).toContain("› the daemon's");
    expect(frame).not.toContain("› hello");
    app.unmount();
  });

  test("C9: watch first, then the eager open; a failed open is a notice", async () => {
    const s = sharedSession({ open: () => Promise.reject(new Error("session is archived")) });
    const app = await mount(s.ctrl);
    expect(s.log.order).toEqual(["watch", "open"]);
    expect(app.lastFrame() ?? "").toContain("could not open the session: session is archived");
    app.unmount();
  });
});

describe("a large history (T-C8)", () => {
  test("20 000 messages: input stays live during the warm, the final frame shows the tail", async () => {
    const s = sharedSession();
    const app = await mount(s.ctrl);
    const messages = Array.from({ length: 20_000 }, (_, i) => ({
      role: i % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: i % 2 === 0 ? `question ${i}` : `answer ${i} with \`code\` and some **markdown**`,
    }));
    s.raise({ kind: "history", messages, compacted: false });
    await delay(20);
    expect(app.lastFrame() ?? "").toContain("loading history");
    app.stdin.write("typed");
    await delay(30);
    expect(app.lastFrame() ?? "").toContain("❯ typed");
    const start = Date.now();
    while (!(app.lastFrame() ?? "").includes("answer 19999") && Date.now() - start < 20_000) {
      await delay(50);
    }
    const frame = app.lastFrame() ?? "";
    expect(frame).toContain("answer 19999");
    expect(frame).not.toContain("loading history");
    app.unmount();
  }, 30_000);
});
