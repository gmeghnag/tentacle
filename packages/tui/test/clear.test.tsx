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
  } = {},
) {
  const log = { clears: 0, closes: 0, creates: 0, aborted: 0 };
  let listener: ((a: SessionActivity) => void) | null = null;
  const ctrl: SessionController = {
    async *send(prompt, signal) {
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
