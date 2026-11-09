import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import type { SessionActivity } from "../src/turn-feed.ts";

// docs/feat/clear-keeps-jobs.md — T19: `/clear` in the App. The daemon resets the
// conversation in place; the TUI keeps its session (no `close`, no new one) and
// shows the daemon's history when it arrives.

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string | undefined) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR stripping
  (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

const NOTE = {
  role: "user" as const,
  content: "Background jobs still running: bg-1",
  note: { kind: "still_running" },
};

function rig(
  opts: {
    clear?: () => Promise<{ before: number; after: number }>;
    holdTurn?: boolean;
    withClear?: boolean;
    resetOnSend?: boolean;
  } = {},
) {
  const log = { clears: 0, closes: 0, creates: 0, aborted: 0 };
  let listener: ((a: SessionActivity) => void) | null = null;
  const ctrl: SessionController = {
    async *send(prompt, signal) {
      if (opts.resetOnSend) {
        // The cleared history reaches an own turn as its snapshot (in-turn).
        yield { type: "history_reset", messages: [NOTE] };
      }
      yield { type: "text", delta: `reply to ${prompt}` };
      if (opts.holdTurn) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => {
            log.aborted += 1;
            resolve();
          });
        });
        yield { type: "turn_end", reason: "cancelled" };
        return;
      }
      yield { type: "turn_end", reason: "end_turn" };
    },
    watch(l) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    close() {
      log.closes += 1;
    },
  };
  if (opts.withClear !== false) {
    ctrl.clear = () => {
      log.clears += 1;
      return opts.clear ? opts.clear() : Promise.resolve({ before: 4, after: 2 });
    };
  }
  const raise = (a: SessionActivity) => listener?.(a);
  const app = render(
    <App
      createSession={() => {
        log.creates += 1;
        return ctrl;
      }}
      model="m"
      cwd="/tmp/work"
    />,
  );
  return { app, log, raise };
}

async function type(stdin: { write(d: string): void }, text: string) {
  stdin.write(text);
  await delay(20);
  stdin.write("\r");
  await delay(60);
}

describe("/clear (docs/feat/clear-keeps-jobs.md)", () => {
  test("T19a keeps the session: no close, no new session; the daemon's history replaces the transcript", async () => {
    // Mutation: take the legacy path (close + new session) → `closes` is 1.
    const r = rig();
    await delay(30);
    await type(r.app.stdin, "hello");
    expect(strip(r.app.lastFrame())).toContain("› hello");
    await type(r.app.stdin, "/clear");
    expect(r.log.clears).toBe(1);
    // The transcript is replaced by the history activity, not by the command.
    expect(strip(r.app.lastFrame())).toContain("› hello");
    r.raise({ kind: "history", messages: [NOTE], reason: "clear" });
    await delay(60);
    const frame = strip(r.app.lastFrame());
    expect(frame).toContain("bg-1");
    expect(frame).not.toContain("› hello");
    // Our own clear: no "on another device" notice.
    expect(frame).not.toContain("cleared on another device");
    expect(r.log.closes).toBe(0);
    expect(r.log.creates).toBe(1);
    r.app.unmount();
  });

  test("T19b a refusal leaves the transcript as it was and shows the failure notice", async () => {
    const r = rig({
      clear: () =>
        Promise.reject(Object.assign(new Error("a turn is already running"), { code: -32004 })),
    });
    await delay(30);
    await type(r.app.stdin, "hello");
    await type(r.app.stdin, "/clear");
    await delay(40);
    const frame = strip(r.app.lastFrame());
    expect(frame).toContain("› hello");
    expect(frame).toContain("/clear failed: a turn is already running");
    expect(r.log.closes).toBe(0);
    // The latch is released: a second /clear asks again.
    await type(r.app.stdin, "/clear");
    expect(r.log.clears).toBe(2);
    r.app.unmount();
  });

  test("T19j (L6a) a clear whose answer was lost to a link drop: the replayed history is still MINE — no 'on another device'", async () => {
    // Mutation: decrement `ownClearsRef` on a "not retried" error → the notice shows.
    const r = rig({
      clear: () => Promise.reject(new Error("link dropped — the request was not retried")),
    });
    await delay(30);
    await type(r.app.stdin, "hello");
    await type(r.app.stdin, "/clear");
    await delay(40);
    expect(strip(r.app.lastFrame())).toContain("no answer");
    r.raise({ kind: "history", messages: [NOTE], reason: "clear" });
    await delay(60);
    const frame = strip(r.app.lastFrame());
    expect(frame).toContain("bg-1");
    expect(frame).not.toContain("cleared on another device");
    r.app.unmount();
  });

  test("T19k (L6b) a clear that did nothing ({0,0}, no session yet) leaves no stale own-count: a later foreign clear is announced", async () => {
    // Mutation: drop the `{0,0}` branch in `onOk` → the foreign notice is swallowed.
    const r = rig({ clear: () => Promise.resolve({ before: 0, after: 0 }) });
    await delay(30);
    await type(r.app.stdin, "/clear");
    await delay(40);
    r.raise({ kind: "history", messages: [NOTE], reason: "clear" });
    await delay(60);
    expect(strip(r.app.lastFrame())).toContain("cleared on another device");
    r.app.unmount();
  });

  test("T19l the latch also lets go when the cleared history reaches an own turn in-turn (history_reset)", async () => {
    // Mutation: drop the `history_reset` release in the stream loop → the second
    // /clear is refused as "already running".
    const r = rig({ resetOnSend: true });
    await delay(30);
    await type(r.app.stdin, "/clear"); // answered; no history activity ever comes
    expect(r.log.clears).toBe(1);
    await type(r.app.stdin, "hello"); // its turn carries the snapshot in-turn
    await type(r.app.stdin, "/clear");
    expect(r.log.clears).toBe(2);
    expect(strip(r.app.lastFrame())).not.toContain("already running");
    r.app.unmount();
  });

  test("T19c another device's clear replaces the transcript and says so", async () => {
    const r = rig();
    await delay(30);
    await type(r.app.stdin, "hello");
    r.raise({ kind: "history", messages: [NOTE], reason: "clear" });
    await delay(60);
    const frame = strip(r.app.lastFrame());
    expect(frame).not.toContain("› hello");
    expect(frame).toContain("bg-1");
    expect(frame).toContain("cleared on another device");
    r.app.unmount();
  });

  test("T19d a session without `clear` takes the legacy path (close, then a new session)", async () => {
    const r = rig({ withClear: false });
    await delay(30);
    await type(r.app.stdin, "/clear");
    expect(r.log.closes).toBe(1);
    expect(r.log.creates).toBe(2);
    r.app.unmount();
  });

  test("T19f the legacy path is still refused mid-turn (it would swap the session under the turn)", async () => {
    // Mutation: exempt `/clear` from the mid-turn guard for every session.
    const r = rig({ withClear: false, holdTurn: true });
    await delay(30);
    r.app.stdin.write("hello");
    await delay(20);
    r.app.stdin.write("\r");
    await delay(60);
    await type(r.app.stdin, "/clear");
    expect(strip(r.app.lastFrame())).toContain("Can't run /clear while a turn is running");
    expect(r.log.closes).toBe(0);
    expect(r.log.creates).toBe(1);
    r.app.unmount();
  });

  test("T19e an own running turn is stopped first; the clear runs when it has ended", async () => {
    // Mutation: clear at once (no stop-then-clear) → `clears` is 1 before the abort settles.
    const r = rig({ holdTurn: true });
    await delay(30);
    r.app.stdin.write("hello");
    await delay(20);
    r.app.stdin.write("\r");
    await delay(60);
    expect(strip(r.app.lastFrame())).toContain("reply to hello");
    await type(r.app.stdin, "/clear");
    // The turn was aborted; its end then triggers the clear, exactly once.
    await delay(80);
    expect(r.log.aborted).toBe(1);
    expect(r.log.clears).toBe(1);
    r.app.unmount();
  });
});

// Review H2: stop-then-clear with a wake pending. The REAL order is: the RPC
// answer first, the `history{clear}` activity a little later (the barrier makes
// the client read a snapshot). A wake that starts in between is held over by the
// history and then wiped from the screen.
function wakeRig(opts: { holdHistoryMs?: number; clearRejects?: boolean } = {}) {
  const events: string[] = [];
  let listener: ((a: SessionActivity) => void) | null = null;
  let exitCb: ((job: unknown) => void) | null = null;
  let cleared = false;
  let sends = 0;
  const jobs = {
    onExit(cb: (job: unknown) => void) {
      exitCb = cb;
      return () => {
        exitCb = null;
      };
    },
    list: () => [],
    get: () => undefined,
  };
  const ctrl: SessionController = {
    async *send(_prompt, signal) {
      sends += 1;
      const n = sends;
      events.push(`send#${n} historyArrived=${cleared}`);
      if (n === 1) {
        yield { type: "text", delta: "reply to first" };
        await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
        yield { type: "turn_end", reason: "cancelled" };
        return;
      }
      yield { type: "text", delta: `WAKE-REPLY-${n}` };
      await delay(20);
      yield { type: "turn_end", reason: "end_turn" };
    },
    watch(l) {
      listener = l;
      return () => {
        listener = null;
      };
    },
    close() {},
    clear() {
      events.push("clear sent");
      return new Promise((resolve, reject) => {
        if (opts.clearRejects) {
          setTimeout(() => {
            events.push("clear refused");
            reject(new Error("a turn is already running"));
          }, 5);
          return;
        }
        // The answer first ...
        setTimeout(() => {
          events.push("clear answered");
          resolve({ before: 4, after: 2 });
        }, 5);
        // ... the cleared history a little later.
        setTimeout(
          () => {
            cleared = true;
            events.push("history{clear}");
            listener?.({ kind: "history", messages: [NOTE], reason: "clear" });
          },
          5 + (opts.holdHistoryMs ?? 25),
        );
      });
    },
  };
  const app = render(
    <App
      createSession={() => ctrl}
      model="m"
      cwd="/tmp/work"
      jobs={jobs as never}
      autoWakeOnJobExit
    />,
  );
  return {
    app,
    events,
    fireExit: () => exitCb?.({ id: "bg-1", command: "sleep 1", status: "exited", exitCode: 0 }),
  };
}

describe("/clear with a wake pending (review H2)", () => {
  async function stopThenClear(r: ReturnType<typeof wakeRig>) {
    await delay(40);
    r.app.stdin.write("first");
    await delay(20);
    r.app.stdin.write("\r");
    await delay(60);
    r.fireExit();
    await delay(30);
    await type(r.app.stdin, "/clear");
    await delay(300);
  }

  test("T19g no turn starts before the cleared history is applied; the wake reply stays on screen", async () => {
    // Mutation: drop `blocked: clearingRef.current` from the wake gate → send#2
    // starts before `history{clear}` and its reply is wiped.
    const r = wakeRig();
    await stopThenClear(r);
    const frame = strip(r.app.lastFrame());
    expect(r.events.filter((e) => e.startsWith("send#2"))).toEqual(["send#2 historyArrived=true"]);
    expect(frame).toContain("WAKE-REPLY-2");
    expect(frame).toContain("Background jobs still running");
    r.app.unmount();
  });

  test("T19i a refused clear releases the gate: the stranded wake runs afterwards", async () => {
    // Mutation: no `wakeIfPending()` in the failure path → send#2 never starts.
    const r = wakeRig({ clearRejects: true });
    await stopThenClear(r);
    expect(r.events).toContain("clear refused");
    expect(r.events.filter((e) => e.startsWith("send#2")).length).toBe(1);
    expect(strip(r.app.lastFrame())).toContain("WAKE-REPLY-2");
    r.app.unmount();
  });
});
