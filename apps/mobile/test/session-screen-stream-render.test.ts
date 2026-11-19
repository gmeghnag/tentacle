/**
 * A streaming turn notifies the screen at most once per window
 * (docs/fix/mobile-fan-jank-device.md): every notification is a full re-render
 * of the session screen on the JS thread, which on a phone is what made the
 * hub's tap wait behind the stream. Nothing is lost: the deferred notification
 * reads the latest state, and a turn's end is shown at once.
 */
import { describe, expect, test } from "bun:test";
import type { SessionActivity, SessionEvent } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import { STREAM_RENDER_MS } from "../src/render-coalesce.ts";
import { createSessionController } from "../src/session-controller.ts";
import {
  type SendableHandle,
  type SessionScreenState,
  createSessionScreen,
} from "../src/session-screen-controller.ts";

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
  }
}

function harness() {
  let watcher: ((activity: SessionActivity) => void) | null = null;
  const clock = { at: 1000 };
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const states: SessionScreenState[] = [];
  const handle: SendableHandle = {
    open: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    watch: (fn) => {
      watcher = fn;
      return () => {
        watcher = null;
      };
    },
    async *send() {},
  };
  const screen = createSessionScreen({
    sessionId: "s1",
    archived: false,
    title: "Alpha",
    project: "e2e-mac",
    controller: createSessionController<SendableHandle>({ newSession: () => handle }),
    broker: new PermissionBroker(undefined, { holdUntilSet: true }),
    now: () => clock.at,
    schedule: (fn, ms) => {
      const timer = { at: clock.at + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    onChange: (state) => states.push(state),
  });
  const advance = (ms: number): void => {
    clock.at += ms;
    for (const timer of timers) {
      if (timer.live && timer.at <= clock.at) {
        timer.live = false;
        timer.fn();
      }
    }
  };
  return {
    screen,
    states,
    advance,
    live: () => timers.filter((t) => t.live).length,
    emit: (a: SessionActivity) => watcher?.(a),
  };
}

/** A foreign turn whose events the test pushes one by one. */
function pushedTurn() {
  const queue: SessionEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const events = (async function* () {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (done) {
        return;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  const push = (e: SessionEvent): void => {
    queue.push(e);
    wake?.();
  };
  return {
    activity: { kind: "turn", turnId: "t1", events, cancel: () => {} } as SessionActivity,
    push,
    end: () => {
      push({ type: "turn_end", reason: "end_turn" } as SessionEvent);
      done = true;
      wake?.();
    },
  };
}

const lastText = (s: SessionScreenState): string => {
  const row = [...s.view.rows].reverse().find((r) => r.kind === "assistant");
  return row !== undefined && "text" in row ? String(row.text) : "";
};

describe("streamed deltas re-render the screen at most once per window", () => {
  test("50 deltas in one window: 1 leading notification, then ONE deferred, never 50", async () => {
    const h = harness();
    await h.screen.open();
    await settle();
    const turn = pushedTurn();
    h.emit(turn.activity);
    await settle();
    const before = h.states.length;
    for (let i = 0; i < 50; i += 1) {
      turn.push({ type: "text", delta: `w${i} ` } as SessionEvent);
      await settle();
    }
    const during = h.states.length - before;
    expect(during).toBeLessThanOrEqual(1);
    // The deferred one carries everything (it reads the state at fire time).
    h.advance(STREAM_RENDER_MS);
    const shown = h.states[h.states.length - 1];
    expect(shown === undefined ? "" : lastText(shown)).toContain("w49");
    expect(h.states.length - before).toBeLessThanOrEqual(2);
  });

  test("the turn's end is shown at once, with every delta, and no timer is left", async () => {
    const h = harness();
    await h.screen.open();
    await settle();
    const turn = pushedTurn();
    h.emit(turn.activity);
    await settle();
    turn.push({ type: "text", delta: "a " } as SessionEvent);
    turn.push({ type: "text", delta: "b " } as SessionEvent);
    turn.push({ type: "text", delta: "c" } as SessionEvent);
    await settle();
    turn.end();
    await settle();
    const shown = h.states[h.states.length - 1];
    expect(shown?.view.composer.running).toBe(false);
    expect(shown === undefined ? "" : lastText(shown)).toBe("a b c");
    expect(h.live()).toBe(0);
  });

  test("a non-stream change (a tool card) is not delayed by a pending delta", async () => {
    const h = harness();
    await h.screen.open();
    await settle();
    const turn = pushedTurn();
    h.emit(turn.activity);
    await settle();
    turn.push({ type: "text", delta: "x" } as SessionEvent);
    turn.push({ type: "text", delta: "y" } as SessionEvent);
    await settle();
    const before = h.states.length;
    turn.push({
      type: "tool_start",
      callId: "c1",
      name: "fs_read",
      input: {},
    } as unknown as SessionEvent);
    await settle();
    expect(h.states.length).toBe(before + 1);
    expect(h.live()).toBe(0);
  });
});
