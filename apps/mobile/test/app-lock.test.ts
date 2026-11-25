/**
 * `app-lock.ts` — the lock's state machine (docs/feat/mobile-lock.md D1, Tests).
 *
 * The table below is the plan's, one row per event sequence: cold start per
 * setting, `loading` covered, `inactive`-only (prompt / Control Center) never
 * locking, background under / at / over the threshold per delay, `immediately`,
 * the LATE-EVENTS case (F7 — the reason the heartbeat exists), a clock moved
 * back and forward, one prompt per episode, cancel → no re-prompt, capability
 * `none`, and weakening vs strengthening (Owner Q6).
 */
import { describe, expect, test } from "bun:test";
import {
  type AppLockEvent,
  type AppLockState,
  type LockDelay,
  type LockView,
  createAppLock,
  initialAppLock,
  isWeaker,
  reduceAppLock,
} from "../src/app-lock.ts";

const MINUTE = 60 * 1000;

/**
 * A hand-driven clock: the module never reads a real one (AGENTS §7). ONE lock
 * instance, as the app keeps it — a replay would re-stamp `lastSeenActive` with
 * the final clock and quietly defeat every elapsed-time assertion below.
 */
function harness(start = 1_000_000) {
  let clock = start;
  const lock = createAppLock({ now: () => clock });
  return {
    /** Move time forward (a real gap in JS execution, e.g. an iOS suspension). */
    advance(ms: number): void {
      clock += ms;
    },
    /** Move the wall clock (may go backwards: F8). */
    set(ms: number): void {
      clock = ms;
    },
    dispatch(event: AppLockEvent): LockView {
      return lock.dispatch(event);
    },
    state(): AppLockState {
      return lock.state();
    },
  };
}

/** The common prelude: launch, load a setting, learn the capability. */
function started(setting: LockDelay, capacity: "ok" | "none" = "ok") {
  const h = harness();
  h.dispatch({ type: "launch" });
  h.dispatch({ type: "loaded", setting });
  h.dispatch({ type: "capability", capability: capacity });
  return h;
}

/** Tick for `ms` at 1 s intervals (the heartbeat as the component runs it). */
function tickFor(h: ReturnType<typeof harness>, ms: number): void {
  for (let elapsed = 0; elapsed < ms; elapsed += 1000) {
    h.advance(1000);
    h.dispatch({ type: "tick" });
  }
}

describe("cold start (F10, Owner Q1)", () => {
  test("before the setting loads the first frame is COVERED", () => {
    const h = harness();
    const view = h.dispatch({ type: "launch" });
    expect(view.cover).toBe("lock");
    expect(view.locked).toBe(true);
  });

  test("a loaded setting still locks: 5m / 1h / immediately", () => {
    for (const setting of ["immediately", "5m", "1h"] as const) {
      const h = harness();
      h.dispatch({ type: "launch" });
      const view = h.dispatch({ type: "loaded", setting });
      expect(view.cover).toBe("lock");
    }
  });

  test("`never` is the one setting that shows content at launch", () => {
    const h = harness();
    h.dispatch({ type: "launch" });
    h.dispatch({ type: "capability", capability: "ok" });
    expect(h.dispatch({ type: "loaded", setting: "never" }).cover).toBe("none");
  });

  test("the lock asks once at launch, and only when the app is active", () => {
    const h = harness();
    expect(h.dispatch({ type: "launch" }).prompt).toBe(true);
    expect(h.dispatch({ type: "loaded", setting: "5m" })).toMatchObject({
      cover: "lock",
      prompt: true,
    });
  });
});

describe("`loaded` is a LAUNCH-time event (review round 1, finding 1)", () => {
  test("a later setting change does not re-lock the app or ask Face ID again", () => {
    // The wiring: Settings tap → `setSetting` (App.tsx), the write lands,
    // `setLockSetting` updates App's state, and LockGate's effect re-dispatches
    // `loaded` with it. Re-running launch's episode logic there locked an
    // unlocked app under the person's finger (finding 1's repro).
    const h = started("5m");
    h.dispatch({ type: "authResult", result: "success" });
    h.dispatch({ type: "setSetting", setting: "immediately" });
    const view = h.dispatch({ type: "loaded", setting: "immediately" });
    expect(view).toMatchObject({ cover: "none", prompt: false, locked: false });
    expect(h.state().setting).toBe("immediately");
  });

  test("a weakening that already succeeded does not re-lock on the follow-up `loaded`", () => {
    const h = started("immediately");
    h.dispatch({ type: "authResult", result: "success" });
    h.dispatch({ type: "setSetting", setting: "1h" });
    h.dispatch({ type: "prompted" });
    h.dispatch({ type: "authResult", result: "success" });
    // App.tsx persists the applied delay and sets its own state: one more `loaded`.
    expect(h.dispatch({ type: "loaded", setting: "1h" })).toMatchObject({
      cover: "none",
      prompt: false,
    });
    expect(h.state().setting).toBe("1h");
  });
});

describe("inactive is not leaving the app (F6)", () => {
  test("Control Center / a call banner / the prompt itself never locks", () => {
    const h = started("immediately");
    h.dispatch({ type: "authResult", result: "success" });
    h.advance(10 * MINUTE);
    // The Face ID prompt's own inactive → active, with no background at all.
    expect(h.dispatch({ type: "appState", state: "inactive" }).cover).toBe("none");
    expect(h.dispatch({ type: "appState", state: "active" }).cover).toBe("none");
  });

  test("`inactive` neither starts the timer nor locks (D1's table, F6)", () => {
    const h = started("5m");
    h.dispatch({ type: "authResult", result: "success" });
    h.dispatch({ type: "appState", state: "inactive" });
    h.advance(10 * MINUTE);
    // No `background` was ever seen, so there is nothing to measure: the plan's
    // table is explicit that `inactive` makes NO timer change. (A real Face ID
    // prompt, Control Center and a call banner all take this path.)
    expect(h.dispatch({ type: "appState", state: "active" }).cover).toBe("none");
  });
});

describe("the background delay (F9, decisions 14)", () => {
  /** Unlock, then leave for `ms` with the heartbeat running until `away`. */
  function awayAndBack(setting: LockDelay, away: number): LockView {
    const h = started(setting);
    h.dispatch({ type: "authResult", result: "success" });
    h.dispatch({ type: "appState", state: "background" });
    h.advance(away);
    return h.dispatch({ type: "appState", state: "active" });
  }

  test("under the threshold stays unlocked", () => {
    expect(awayAndBack("5m", 4 * MINUTE).cover).toBe("none");
  });

  test("EXACTLY at the threshold does not lock (strictly greater)", () => {
    expect(awayAndBack("5m", 5 * MINUTE).cover).toBe("none");
  });

  test("1 ms over the threshold locks", () => {
    expect(awayAndBack("5m", 5 * MINUTE + 1).cover).toBe("lock");
  });

  test("`immediately` locks on the way out, not on the way back", () => {
    const h = started("immediately");
    h.dispatch({ type: "authResult", result: "success" });
    expect(h.dispatch({ type: "appState", state: "background" }).cover).toBe("lock");
    expect(h.dispatch({ type: "appState", state: "active" }).cover).toBe("lock");
  });

  test("`1h` holds for 59 minutes and locks at 61", () => {
    expect(awayAndBack("1h", 59 * MINUTE).cover).toBe("none");
    expect(awayAndBack("1h", 61 * MINUTE).cover).toBe("lock");
  });

  test("a lock taken on the way out prompts on the way back", () => {
    const h = started("immediately");
    h.dispatch({ type: "authResult", result: "success" });
    expect(h.dispatch({ type: "appState", state: "background" }).prompt).toBe(false);
    expect(h.dispatch({ type: "appState", state: "active" }).prompt).toBe(true);
  });
});

describe("F7 — the late-events fail-open path (the heartbeat's reason)", () => {
  test("ticks stop, then background+active arrive together 10 min later → LOCKED", () => {
    const h = started("5m");
    h.dispatch({ type: "authResult", result: "success" });
    // JS is suspended: no ticks at all, and the two events arrive back to back
    // only when it resumes. A `background` timestamp would read ~0 s here.
    h.advance(10 * MINUTE);
    h.dispatch({ type: "appState", state: "background" });
    h.dispatch({ type: "tick" });
    expect(h.dispatch({ type: "appState", state: "active" }).cover).toBe("lock");
  });

  test("the elapsed time is measured from the LAST TICK, not the background event", () => {
    const h = started("5m");
    h.dispatch({ type: "authResult", result: "success" });
    tickFor(h, 60_000);
    // 6 minutes of suspension, then the events finally arrive together.
    h.advance(6 * MINUTE);
    h.dispatch({ type: "appState", state: "background" });
    h.dispatch({ type: "appState", state: "active" });
    // 6 min of silence + 0 s from the event: only the heartbeat catches this.
    expect(h.dispatch({ type: "appState", state: "inactive" }).cover).toBe("lock");
  });
});

describe("F8 — a clock that moved", () => {
  test("backwards locks (fail-closed)", () => {
    const h = started("5m");
    h.dispatch({ type: "authResult", result: "success" });
    h.dispatch({ type: "appState", state: "background" });
    h.set(1_000_000 - 60_000);
    expect(h.dispatch({ type: "appState", state: "active" }).cover).toBe("lock");
  });

  test("forwards locks (harmless)", () => {
    const h = started("5m");
    h.dispatch({ type: "authResult", result: "success" });
    h.dispatch({ type: "appState", state: "background" });
    h.advance(24 * 60 * MINUTE);
    expect(h.dispatch({ type: "appState", state: "active" }).cover).toBe("lock");
  });
});

describe("one prompt per episode, no loops (F5)", () => {
  test("a cancel keeps the Unlock button and never re-prompts", () => {
    const h = started("immediately");
    h.dispatch({ type: "authResult", result: "success" });
    h.dispatch({ type: "appState", state: "background" });
    h.dispatch({ type: "appState", state: "active" });
    // The component raised the prompt and acked it (LockGate's effect).
    h.dispatch({ type: "prompted" });
    for (const result of ["cancel", "fail", "lockout", "not_interactive"] as const) {
      h.dispatch({ type: "appState", state: "inactive" });
      const view = h.dispatch({ type: "appState", state: "active" });
      // The prompt's own inactive → active must NOT re-arm it.
      expect(view.cover).toBe("lock");
      expect(view.prompt).toBe(false);
      h.dispatch({ type: "authResult", result });
    }
  });

  test("the component's prompt ack consumes the one-shot flag (no re-prompt loops)", () => {
    const h = started("immediately");
    h.dispatch({ type: "authResult", result: "success" });
    h.dispatch({ type: "appState", state: "background" });
    expect(h.dispatch({ type: "appState", state: "active" }).prompt).toBe(true);
    // Raising the system prompt itself makes the app `inactive` → `active`; the
    // ack is what stops that round trip from raising a SECOND evaluation.
    expect(h.dispatch({ type: "prompted" }).prompt).toBe(false);
    h.dispatch({ type: "appState", state: "inactive" });
    expect(h.dispatch({ type: "appState", state: "active" }).prompt).toBe(false);
  });

  test("a successful auth clears the episode and the next lock prompts again", () => {
    const h = started("immediately");
    h.dispatch({ type: "authResult", result: "success" });
    h.dispatch({ type: "appState", state: "background" });
    expect(h.dispatch({ type: "appState", state: "active" }).prompt).toBe(true);
    expect(h.dispatch({ type: "authResult", result: "success" }).cover).toBe("none");
    h.dispatch({ type: "appState", state: "background" });
    const back = h.dispatch({ type: "appState", state: "active" });
    expect(back.prompt).toBe(true);
    h.dispatch({ type: "prompted" });
  });
});

describe("F2 — a device that cannot authenticate (Owner Q5)", () => {
  test("capability none unlocks at once and carries a notice", () => {
    const h = harness();
    h.dispatch({ type: "launch" });
    h.dispatch({ type: "loaded", setting: "5m" });
    expect(h.dispatch({ type: "capability", capability: "none" })).toEqual({
      cover: "none",
      prompt: false,
      locked: false,
      notice: "no-passcode",
    });
  });

  test("`unknown` (not asked yet) never unlocks anything", () => {
    const h = harness();
    h.dispatch({ type: "launch" });
    expect(h.dispatch({ type: "loaded", setting: "5m" }).cover).toBe("lock");
  });
});

describe("Owner Q6 — weakening the lock needs a successful auth first", () => {
  test("isWeaker reads a longer delay as weaker", () => {
    expect(isWeaker("never", "5m")).toBe(true);
    expect(isWeaker("1h", "5m")).toBe(true);
    expect(isWeaker("immediately", "5m")).toBe(false);
    expect(isWeaker("5m", "5m")).toBe(false);
  });

  test("strengthening applies at once", () => {
    const h = started("1h");
    h.dispatch({ type: "authResult", result: "success" });
    h.dispatch({ type: "setSetting", setting: "immediately" });
    expect(h.state().setting).toBe("immediately");
  });

  test("weakening waits for a successful auth and prompts for it", () => {
    const h = started("immediately");
    h.dispatch({ type: "authResult", result: "success" });
    // `never` is weaker than `immediately`: it must not take effect yet.
    expect(h.dispatch({ type: "setSetting", setting: "never" }).prompt).toBe(true);
    expect(h.state().setting).toBe("immediately");
    // The pending value is what App.tsx persists on the NEXT successful auth.
    expect(h.state().pendingSetting).toBe("never");
    // A cancel leaves the old (stronger) setting in force.
    h.dispatch({ type: "authResult", result: "cancel" });
    expect(h.state().setting).toBe("immediately");
    expect(h.state().pendingSetting).toBeUndefined();
    h.dispatch({ type: "setSetting", setting: "never" });
    h.dispatch({ type: "authResult", result: "success" });
    expect(h.state().setting).toBe("never");
    // Applied: nothing is left pending (App.tsx writes it once, not twice).
    expect(h.state().pendingSetting).toBeUndefined();
  });

  test("a weakening NEVER applies without an auth, even if the app is already unlocked", () => {
    // The whole point of Owner Q6: someone holding an unlocked phone must not be
    // able to turn the lock off for later. An unlocked app is exactly that state.
    const h = started("5m");
    h.dispatch({ type: "authResult", result: "success" });
    expect(h.state().locked).toBe(false);
    h.dispatch({ type: "setSetting", setting: "never" });
    // Still the old delay, and the app does NOT now show content forever.
    expect(h.state().setting).toBe("5m");
    h.dispatch({ type: "appState", state: "background" });
    h.advance(10 * MINUTE);
    expect(h.dispatch({ type: "appState", state: "active" }).cover).toBe("lock");
  });
});

describe("reduceAppLock is pure and total", () => {
  test("the same state and event always give the same state", () => {
    const start = initialAppLock(() => 5);
    const once = reduceAppLock(start, { type: "launch" }, 5);
    const twice = reduceAppLock(start, { type: "launch" }, 5);
    expect(once).toEqual(twice);
    // And the input state is untouched (no in-place mutation).
    expect(start.locked).toBe(true);
    expect(start.prompted).toBe(false);
  });
});

describe("createAppLock's subscription — the sheets read `locked` from here (S3)", () => {
  /** A lock whose setting is loaded and capability is known, then unlocked. */
  function unlocked(now: () => number) {
    const lock = createAppLock({ now });
    lock.dispatch({ type: "launch" });
    lock.dispatch({ type: "capability", capability: "ok" });
    lock.dispatch({ type: "loaded", setting: "immediately" });
    lock.dispatch({ type: "authResult", result: "success" });
    return lock;
  }

  test("a listener sees every new view, and `locked` really changes", () => {
    const at = 1_000;
    const lock = unlocked(() => at);
    const seen: boolean[] = [];
    lock.subscribe((view) => seen.push(view.locked));
    expect(lock.view().locked).toBe(false);
    // Going to the background under `immediately` locks at once (app-lock D1).
    lock.dispatch({ type: "appState", state: "background" });
    expect(seen).toEqual([true]);
    expect(lock.view().locked).toBe(true);
  });

  test("the reloaded setting reaches a listener too (the `loaded` leg)", () => {
    const lock = createAppLock({ now: () => 0 });
    const covers: string[] = [];
    lock.subscribe((view) => covers.push(view.cover));
    lock.dispatch({ type: "launch" });
    lock.dispatch({ type: "capability", capability: "ok" });
    // Still `loading` → covered (F10); then the read lands.
    expect(lock.view().cover).toBe("lock");
    lock.dispatch({ type: "loaded", setting: "never" });
    expect(covers[covers.length - 1]).toBe("none");
    expect(lock.view().cover).toBe("none");
  });

  test("unsubscribing stops it, and a listener still hears every later event", () => {
    const lock = createAppLock({ now: () => 0 });
    const calls: string[] = [];
    const off = lock.subscribe(() => calls.push("first"));
    lock.subscribe(() => calls.push("second"));
    lock.dispatch({ type: "launch" });
    expect(calls).toEqual(["first", "second"]);
    off();
    lock.dispatch({ type: "tick" });
    expect(calls).toEqual(["first", "second", "second"]);
  });

  test("the lock is NOT penetrated by a subscriber list shared between instances", () => {
    // Two instances are two truths (the fail-open risk LockGate's own doc names):
    // one's listeners must never hear the other's events.
    const a = createAppLock({ now: () => 0 });
    const b = createAppLock({ now: () => 0 });
    const heard: string[] = [];
    a.subscribe(() => heard.push("a"));
    b.dispatch({ type: "launch" });
    expect(heard).toEqual([]);
  });
});
