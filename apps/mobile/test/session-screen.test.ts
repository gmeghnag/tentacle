/**
 * The session screen's wiring (docs/feat/mobile-session-view.md 12c): what a tap,
 * an activity and a link change DO. The screen itself is dumb, so everything the
 * plan's failure modes name is decided here and is tested without a simulator.
 *
 * The seam is a fake session handle (as `session-controller.test.ts`), plus the
 * app's REAL broker (`createLinkBroker`'s shape: `holdUntilSet`, no requester) —
 * because "the sheet's requester is set on the ONE broker" is the invariant the
 * whole task stands on (AGENTS §7 "single broker").
 */
import { describe, expect, test } from "bun:test";
import type { SessionActivity, SessionEvent } from "@tentacle/client";
import { PermissionBroker, type PermissionResponse } from "@tentacle/core";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import { FAILED_NOTICE, REFUSED_NOTICE, RESYNC_FAILED_NOTICE } from "../src/composer.ts";
import { createSessionController } from "../src/session-controller.ts";
import {
  type SendableHandle,
  type SessionScreenState,
  createSessionScreen,
} from "../src/session-screen-controller.ts";

interface FakeSession extends SendableHandle {
  /** Feed a `turn` activity, as another device's turn (or one running at attach). */
  emitActivity(activity: SessionActivity): void;
  /** What the controller passed to `send` (the turn id and its signal). */
  readonly sent: () => readonly { prompt: string; signal?: AbortSignal; turnId?: string }[];
  readonly detaches: () => number;
  readonly watches: () => number;
}

/** A handle whose `open` settles at once and whose `send` the test drives. */
function fakeSession(sessions: FakeSession[], id: string): FakeSession {
  let listener: ((activity: SessionActivity) => void) | null = null;
  const sent: { prompt: string; signal?: AbortSignal; turnId?: string }[] = [];
  let detaches = 0;
  let watches = 0;
  const handle: FakeSession = {
    open: () => Promise.resolve(),
    detach: () => {
      detaches += 1;
      return Promise.resolve();
    },
    watch: (fn) => {
      watches += 1;
      listener = fn;
      return () => {
        listener = null;
      };
    },
    async *send(prompt, signal, opts) {
      sent.push({ prompt, ...(signal === undefined ? {} : { signal }), ...(opts ?? {}) });
      yield { type: "user_message", text: prompt };
      yield { type: "text", delta: `echo: ${prompt}` };
      yield { type: "turn_end", reason: "end_turn" };
    },
    emitActivity: (activity) => listener?.(activity),
    sent: () => sent,
    detaches: () => detaches,
    watches: () => watches,
  };
  sessions.push(handle);
  return handle;
}

function harness(options: { archived?: boolean } = {}) {
  const sessions: FakeSession[] = [];
  const brokers: PermissionBroker[] = [];
  const states: SessionScreenState[] = [];
  const make = (sessionId = "s1") => {
    const broker = new PermissionBroker(undefined, { holdUntilSet: true });
    brokers.push(broker);
    const screen = createSessionScreen({
      sessionId,
      archived: options.archived ?? false,
      title: "Alpha",
      project: "e2e-mac",
      controller: createSessionController<SendableHandle>({
        newSession: (id) => fakeSession(sessions, id),
      }),
      broker,
      now: () => clock.at,
      onChange: (state) => states.push(state),
    });
    return { screen, broker };
  };
  const clock = { at: 1000 };
  return { make, sessions, brokers, states, clock };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    await Promise.resolve();
  }
}

/** A `turn` activity the test streams by hand. */
function turnActivity(turnId: string, cancelled = { value: false }): SessionActivity {
  return {
    kind: "turn",
    turnId,
    events: (async function* () {
      yield { type: "text", delta: "streaming" } as SessionEvent;
      yield { type: "turn_end", reason: "end_turn" } as SessionEvent;
    })(),
    cancel: () => {
      cancelled.value = true;
    },
  };
}

describe("opening the screen", () => {
  test("it attaches, mounts the sheet's requester on the ONE broker, and goes Live", async () => {
    const h = harness();
    const { screen, broker } = h.make();
    await screen.open();
    expect(screen.state().status).toEqual({ phase: "open" });
    expect(screen.state().view.state).toBe("Live");
    // The broker is the app's own instance and now HAS a requester: an ask
    // reaches the sheet instead of waiting forever (12a's hold, 12c's sheet).
    const asked = broker.request({
      tool: "fs_write",
      level: "ask",
      title: "Write a file",
      input: {},
    });
    await settle();
    expect(screen.state().sheet).toMatchObject({ kind: "asking" });
    // Nobody tapped: the ask is still pending (never auto-answered).
    expect(screen.state().sheet.kind).toBe("asking");
    void asked;
  });

  test("a route flagged `archived` shows its banner and Reopen while the attach is in flight (review round 1)", async () => {
    // The plan (12c, "Archived sessions"): tapping an archived row opens the
    // screen WITH the archived banner and a Reopen button. Waiting for the
    // daemon to refuse the plain attach makes `deps.archived` dead code — a
    // slow or `reconnecting` link shows `Loading…` and no Reopen at all, which
    // contradicts what the doc claims this flag decides.
    // Mutation: drop `archived` from the `sessionView` call's input → this is red.
    const screen = createSessionScreen({
      sessionId: "old",
      archived: true,
      title: "Old",
      project: "e2e-mac",
      controller: {
        // Still attaching: the daemon has not answered yet.
        open: () => new Promise(() => {}),
        leave: async () => {},
        dispose: () => {},
        follows: () => false,
      },
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1000,
    });
    void screen.open();
    expect(screen.state().view.banner?.kind).toBe("archived");
    expect(screen.state().view.reopen).toBe(true);
    expect(screen.state().view.editable).toBe(false);
  });

  test("a route flagged `archived` still attaches WITHOUT reopen (browsing never revives — Owner Q4)", async () => {
    // The flag never makes an attach pass `reopen` (it only decides the banner,
    // announced from the first render and kept once the daemon answers).
    // Mutation: pass `reopen: deps.archived` → `opens` becomes `[true]` and
    // this test is red.
    const opens: boolean[] = [];
    const screen = createSessionScreen({
      sessionId: "s1",
      archived: true,
      title: "Bravo",
      project: "e2e-mac",
      controller: {
        open: async (_id, options) => {
          opens.push(options?.reopen === true);
          return { ok: true, session: fakeSession([], "s1") } as const;
        },
        leave: async () => {},
        dispose: () => {},
        follows: () => false,
      },
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1000,
    });
    await screen.open();
    expect(opens).toEqual([false]);
  });

  test("a Reopen tapped while the first attach is still in flight is HONOURED, not swallowed (round-1 finding 2)", async () => {
    // The archived banner (with Reopen) shows from the first render, so the
    // button exists before the plain attach has answered. A tap there must
    // reopen once that attach says `archived` — not become a dead button the
    // person has to press twice.
    // Mutation: drop `queuedReopen` (return early) → `opens` stays [false] and
    // the phase stays "failed" → this is red.
    const opens: boolean[] = [];
    let releaseFirst: (r: { ok: false; reason: "archived" }) => void = () => {};
    const screen = createSessionScreen({
      sessionId: "old",
      archived: true,
      title: "Old",
      project: "e2e-mac",
      controller: {
        open: async (_id, options) => {
          opens.push(options?.reopen === true);
          if (options?.reopen === true) {
            return { ok: true, session: fakeSession([], "old") } as const;
          }
          return new Promise((resolve) => {
            releaseFirst = resolve;
          });
        },
        leave: async () => {},
        dispose: () => {},
        follows: () => false,
      },
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1000,
    });
    void screen.open();
    expect(screen.state().view.reopen).toBe(true); // offered at once
    screen.reopen(); // tapped while the plain attach runs
    await settle();
    expect(opens).toEqual([false]); // the tap did not run a second attach yet
    releaseFirst({ ok: false, reason: "archived" });
    await settle();
    expect(opens).toEqual([false, true]); // honoured as soon as it settled
    expect(screen.state().status.phase).toBe("open");
  });

  test("an attach that failed as archived offers Reopen, and Reopen attaches", async () => {
    // The daemon says SessionArchived to the plain attach; the Reopen button's
    // attach passes `reopen: true` and succeeds.
    const brokers: PermissionBroker[] = [];
    const opens: boolean[] = [];
    const screen = createSessionScreen({
      sessionId: "s1",
      archived: true,
      title: "Bravo",
      project: "e2e-mac",
      controller: {
        open: async (_id, options) => {
          opens.push(options?.reopen === true);
          if (options?.reopen !== true) {
            return { ok: false, reason: "archived" } as const;
          }
          const handle = fakeSession([], "s1");
          return { ok: true, session: handle } as const;
        },
        leave: async () => {},
        dispose: () => {},
        follows: () => false,
      },
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1000,
      onChange: (state) => brokers.push(state.sheet as never),
    });
    await screen.open();
    expect(opens).toEqual([false]); // merely opening the screen never reopens
    expect(screen.state().view.reopen).toBe(true);
    expect(screen.state().view.banner?.kind).toBe("archived");
    screen.reopen();
    await settle();
    expect(opens).toEqual([false, true]);
    expect(screen.state().status.phase).toBe("open");
  });

  test("a timeout offers Retry, and Retry attaches again (F16)", async () => {
    const reasons = ["timeout", "open"] as const;
    let at = 0;
    let opens = 0;
    const screen = createSessionScreen({
      sessionId: "s1",
      archived: false,
      title: "Alpha",
      project: "e2e-mac",
      controller: {
        open: async () => {
          opens += 1;
          const reason = reasons[at];
          at += 1;
          return reason === "open"
            ? ({ ok: true, session: fakeSession([], "s1") } as const)
            : ({ ok: false, reason: "timeout" } as const);
        },
        leave: async () => {},
        dispose: () => {},
        follows: () => false,
      },
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1000,
    });
    await screen.open();
    expect(screen.state().view.retry).toBe(true);
    expect(screen.state().view.banner?.kind).toBe("timeout");
    screen.retry();
    await settle();
    expect(opens).toBe(2);
    expect(screen.state().status.phase).toBe("open");
    expect(screen.state().view.banner).toBeNull();
  });
});

describe("sending and stopping (decision 15, F12, F13)", () => {
  test("a send folds its own turn into rows, and the draft clears", async () => {
    const h = harness();
    const { screen } = h.make();
    await screen.open();
    screen.setDraft("hello");
    expect(screen.state().view.composer.button).toBe("send");
    screen.press();
    await settle();
    expect(h.sessions[0]?.sent()).toHaveLength(1);
    expect(h.sessions[0]?.sent()[0]?.prompt).toBe("hello");
    expect(screen.state().draft).toBe("");
    const kinds = screen.state().transcript.rows.map((row) => row.kind);
    expect(kinds).toEqual(["user", "assistant"]);
    expect(screen.state().transcript.turn).toBeNull(); // the bracket closed
  });

  test("an OWN turn and a FOREIGN one produce identical rows (F10)", async () => {
    const h = harness();
    const own = h.make();
    await own.screen.open();
    own.screen.setDraft("same");
    own.screen.press();
    await settle();

    const foreignHarness = harness();
    const foreign = foreignHarness.make();
    await foreign.screen.open();
    foreignHarness.sessions[0]?.emitActivity({
      kind: "turn",
      turnId: "t-f",
      events: (async function* () {
        yield { type: "user_message", text: "same" } as SessionEvent;
        yield { type: "text", delta: "echo: same" } as SessionEvent;
        yield { type: "turn_end", reason: "end_turn" } as SessionEvent;
      })(),
      cancel: () => {},
    });
    await settle();
    expect(foreign.screen.state().transcript.rows).toEqual(own.screen.state().transcript.rows);
  });

  test("a FOREIGN turn is stoppable: the Stop button cancels THAT turn id", async () => {
    const h = harness();
    const { screen } = h.make();
    await screen.open();
    const cancelled = { value: false };
    h.sessions[0]?.emitActivity({
      kind: "turn",
      turnId: "t-foreign",
      // A stream that never ends on its own: the turn stays running.
      events: (async function* () {
        yield { type: "text", delta: "streaming" } as SessionEvent;
        await new Promise(() => {});
      })(),
      cancel: () => {
        cancelled.value = true;
      },
    });
    await settle();
    expect(screen.state().view.composer.button).toBe("stop");
    screen.press();
    expect(cancelled.value).toBe(true);
  });

  test("this phone's OWN turn stops through its own abort signal (Stop = Esc for own)", async () => {
    // A handle whose `send` streams forever unless its signal aborts: the only
    // way the bracket closes is the composer's Stop reaching THAT signal.
    // Mutation: `press()`'s own branch dropping `ownControl?.abort()` → red
    // (the bracket never closes and the button stays Stop).
    const signals: AbortSignal[] = [];
    const handle: SendableHandle = {
      open: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      watch: () => () => {},
      send: async function* (prompt: string, signal?: AbortSignal) {
        yield { type: "user_message", text: prompt } as SessionEvent;
        if (signal !== undefined) {
          signals.push(signal);
        }
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "turn_end", reason: "cancelled" } as SessionEvent;
      },
    };
    const screen = createSessionScreen({
      sessionId: "s1",
      archived: false,
      title: "Alpha",
      project: "e2e-mac",
      controller: createSessionController<SendableHandle>({ newSession: () => handle }),
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1000,
    });
    await screen.open();
    screen.setDraft("a long turn");
    screen.press();
    await settle();
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(screen.state().view.composer.button).toBe("stop");
    screen.press(); // Stop
    await settle();
    expect(signals[0]?.aborted).toBe(true);
    expect(screen.state().transcript.turn).toBeNull(); // the bracket closed
  });
});

describe("stopTurn — the hub's Stop (docs/feat/mobile-hub.md P2)", () => {
  /** A foreign turn whose stream never ends on its own, and a spy on its cancel. */
  async function foreignRunning(h: ReturnType<typeof harness>) {
    const cancelled = { value: false };
    h.sessions[0]?.emitActivity({
      kind: "turn",
      turnId: "t-hub",
      events: (async function* () {
        yield { type: "text", delta: "streaming" } as SessionEvent;
        await new Promise(() => {});
      })(),
      cancel: () => {
        cancelled.value = true;
      },
    });
    await settle();
    return cancelled;
  }

  test("a draft in the field does not turn the hub's Stop into a steer: the foreign turn is cancelled", async () => {
    // Mutation: `stopTurn` calling `act()` (the composer's tap) → red: with a
    // draft the composer's action is `queue`, so nothing cancels the turn.
    const h = harness();
    const { screen } = h.make();
    await screen.open();
    const cancelled = await foreignRunning(h);
    screen.setDraft("half-written steer");
    expect(screen.state().view.composer.button).toBe("queue");
    screen.stopTurn();
    expect(cancelled.value).toBe(true);
    expect(screen.state().draft).toBe("half-written steer");
  });

  test("an OWN turn with a draft stops through its own abort signal", async () => {
    const signals: AbortSignal[] = [];
    const handle: SendableHandle = {
      open: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      watch: () => () => {},
      send: async function* (prompt: string, signal?: AbortSignal) {
        yield { type: "user_message", text: prompt } as SessionEvent;
        if (signal !== undefined) {
          signals.push(signal);
        }
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "turn_end", reason: "cancelled" } as SessionEvent;
      },
    };
    const screen = createSessionScreen({
      sessionId: "s1",
      archived: false,
      title: "Alpha",
      project: "e2e-mac",
      controller: createSessionController<SendableHandle>({ newSession: () => handle }),
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1000,
    });
    await screen.open();
    screen.setDraft("a long turn");
    screen.press();
    await settle();
    screen.setDraft("typed while it runs");
    expect(signals[0]?.aborted).toBe(false);
    screen.stopTurn();
    await settle();
    expect(signals[0]?.aborted).toBe(true);
    expect(screen.state().transcript.turn).toBeNull();
  });

  test("link down (M8): nothing is cancelled — Stop travels the wire", async () => {
    const h = harness();
    const { screen } = h.make();
    await screen.open();
    const cancelled = await foreignRunning(h);
    screen.link(false);
    await settle();
    expect(screen.state().transcript.link).toBe("down");
    screen.stopTurn();
    expect(cancelled.value).toBe(false);
  });

  test("no turn running: a no-op", async () => {
    const h = harness();
    const { screen } = h.make();
    await screen.open();
    expect(() => screen.stopTurn()).not.toThrow();
    expect(screen.state().transcript.turn).toBeNull();
  });

  test("a session closed from another device: the hub's Stop aborts nothing", async () => {
    // Review round 3's surviving mutation: `stopTurn` passing `ended: null` was
    // 22/0, i.e. the ended guard of the hub's Stop was unpinned. With an OWN turn
    // still streaming, a Stop that ignored `ended` would abort that stream — a
    // local cancel of a turn the daemon has already closed the session under,
    // which the composer's own truth table refuses (`ended` ⇒ nothing).
    const signals: AbortSignal[] = [];
    const listeners: ((activity: SessionActivity) => void)[] = [];
    const handle: SendableHandle = {
      open: () => Promise.resolve(),
      detach: () => Promise.resolve(),
      watch: (fn) => {
        listeners[0] = fn;
        return () => {
          listeners.length = 0;
        };
      },
      send: async function* (prompt: string, signal?: AbortSignal) {
        yield { type: "user_message", text: prompt } as SessionEvent;
        if (signal !== undefined) {
          signals.push(signal);
        }
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "turn_end", reason: "cancelled" } as SessionEvent;
      },
    };
    const screen = createSessionScreen({
      sessionId: "s1",
      archived: false,
      title: "Alpha",
      project: "e2e-mac",
      controller: createSessionController<SendableHandle>({ newSession: () => handle }),
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1000,
    });
    await screen.open();
    screen.setDraft("a long turn");
    screen.press();
    await settle();
    expect(signals.length).toBe(1);
    expect(signals[0]?.aborted).toBe(false);
    expect(screen.state().view.composer.button).toBe("stop");
    // The close travels the same listener this screen folded its turn on.
    listeners[0]?.({ kind: "closed", reason: "deleted" });
    await settle();
    expect(screen.state().view.editable).toBe(false);
    screen.stopTurn();
    await settle();
    expect(signals[0]?.aborted).toBe(false);
  });
});

describe("sending and stopping, continued", () => {
  test("a send refused before the ack puts the text BACK with a notice (F13)", async () => {
    const h = harness();
    const { screen } = h.make();
    await screen.open();
    const session = h.sessions[0];
    if (session === undefined) {
      throw new Error("no session");
    }
    Object.assign(session, {
      send: async function* () {
        // Nothing yielded: the daemon refused it before the ack (`send` rejects).
        if (false as boolean) {
          yield { type: "turn_end", reason: "end_turn" } as SessionEvent;
        }
        throw new RpcError(DomainErrorCode.TurnInProgress, "a turn is already running");
      },
    });
    screen.setDraft("my words");
    screen.press();
    await settle();
    expect(screen.state().draft).toBe("my words"); // never lost
    expect(screen.state().notice).toBe(REFUSED_NOTICE);
  });

  test("a send that failed for another reason also restores the text", async () => {
    const h = harness();
    const { screen } = h.make();
    await screen.open();
    const session = h.sessions[0];
    if (session === undefined) {
      throw new Error("no session");
    }
    Object.assign(session, {
      send: async function* () {
        if (false as boolean) {
          yield { type: "turn_end", reason: "end_turn" } as SessionEvent;
        }
        throw new Error("the socket died");
      },
    });
    screen.setDraft("kept words");
    screen.press();
    await settle();
    expect(screen.state().draft).toBe("kept words");
    expect(screen.state().notice).toBe(FAILED_NOTICE);
  });

  test("a link down keeps the draft and offers Send later instead (F12, 13d D1)", async () => {
    const h = harness();
    const { screen } = h.make();
    await screen.open();
    screen.setDraft("kept");
    screen.link(false);
    expect(screen.state().view.banner?.kind).toBe("reconnecting");
    // 13d (D1): offline text is a Send later tap — 12c's dead button.
    expect(screen.state().view.composer.button).toBe("send-later");
    expect(screen.state().draft).toBe("kept");
    screen.link(true);
    expect(screen.state().view.banner).toBeNull();
    expect(screen.state().view.composer.button).toBe("send");
  });
});

describe("an ask reaches the person through the sheet (F1, F2)", () => {
  test("the sheet's answer IS the answer the broker hands back", async () => {
    const h = harness();
    const { screen, broker } = h.make();
    await screen.open();
    const answered: PermissionResponse[] = [];
    const asked = broker.request({
      tool: "fs_write",
      level: "ask",
      title: "Write a file",
      input: {},
    });
    asked.then((response) => answered.push(response));
    await settle();
    h.clock.at += 1000; // past the age guard
    expect(screen.sheet().answer("allow_once")).toBe("sent");
    await settle();
    expect(answered).toEqual([{ allowed: true, scope: "once" }]);
    expect(screen.state().sheet.kind).toBe("idle");
  });

  test("leaving withdraws the ask and RELEASES the broker (a detach sends nothing)", async () => {
    const h = harness();
    const { screen, broker } = h.make();
    await screen.open();
    const asked = broker.request({
      tool: "fs_write",
      level: "ask",
      title: "Write a file",
      input: {},
    });
    await settle();
    expect(screen.state().sheet.kind).toBe("asking");
    await screen.leave();
    expect(await asked).toEqual({ allowed: false, dismissed: true });
    expect(h.sessions[0]?.detaches()).toBe(1); // detach, never close
    // The broker has no requester again, so a later ask WAITS (12a's hold) and
    // is NOT presented by the sheet of a screen that already left: a departed
    // screen must never show — let alone answer — a new ask (AGENTS §7).
    // Mutation: dropping `deps.broker.reset()` from `leave()` → the ask reaches
    // the sheet again and `sheet.kind` becomes "asking" → this is red.
    const after = broker.request({ tool: "fs_write", level: "ask", title: "again", input: {} });
    let settled = false;
    after.then(() => {
      settled = true;
    });
    await settle();
    expect(settled).toBe(false);
    expect(screen.state().sheet.kind).toBe("idle");
  });

  test("a departed screen's late dispose() does NOT clear the NEXT screen's requester (review round 1, HIGH)", async () => {
    // The app has ONE link, therefore ONE broker (`connection.ts`), shared by
    // every session screen ever mounted on it. A's unmount is
    // `leave().then(() => dispose())` (`SessionScreen.tsx:54`), so A's
    // `dispose()` runs whenever A's `session/detach` settles — possibly AFTER B
    // has mounted its sheet's requester. If `dispose()` resets the broker
    // unconditionally, every ask on B is held silently: no sheet, the turn
    // hangs, nothing says why (AGENTS §7 "single broker"'s failure mode).
    // Mutation: `deps.broker.reset()` (unconditional) in `dispose()` → B's
    // `sheet.kind` is "idle" and this test is red; the same mutation in
    // `leave()` reddens it too (a late leave must not clear B's requester).
    const broker = new PermissionBroker(undefined, { holdUntilSet: true });
    const sessions: FakeSession[] = [];
    let releaseA: () => void = () => {};
    const shared = createSessionController<SendableHandle>({
      newSession: (id) => fakeSession(sessions, id),
    });
    const screenFor = (sessionId: string) =>
      createSessionScreen({
        sessionId,
        archived: false,
        title: sessionId,
        project: "e2e-mac",
        controller: shared,
        broker,
        now: () => 1000,
      });
    const a = screenFor("a");
    await a.open();
    // A's detach is slow (a reconnecting link): the promise settles later.
    const slow: FakeSession = sessions[0] as FakeSession;
    const realDetach = slow.detach;
    (slow as unknown as { detach: () => Promise<void> }).detach = () =>
      new Promise((resolve) => {
        releaseA = () => {
          void realDetach();
          resolve();
        };
      });
    const leaving = a.leave().then(() => a.dispose());

    // B opens while A's detach is still in flight and mounts its requester.
    const b = screenFor("b");
    await b.open();

    // A's detach settles now: A's `dispose()` runs after B is live.
    releaseA();
    await leaving;

    const asked = broker.request({
      tool: "fs_write",
      level: "ask",
      title: "Write a file",
      input: {},
    });
    await settle();
    expect(b.state().sheet.kind).toBe("asking"); // B still owns the broker
    void asked;
  });
});

describe("the transcript's end and the thumbnails window", () => {
  test("a closed activity ends the screen: the composer offers nothing (F14)", async () => {
    const h = harness();
    const { screen } = h.make();
    await screen.open();
    screen.setDraft("typed");
    h.sessions[0]?.emitActivity({ kind: "closed", reason: "deleted" });
    await settle();
    const view = screen.state().view;
    expect(view.banner?.kind).toBe("deleted");
    expect(view.editable).toBe(false);
    expect(view.composer.button).toBe("disabled");
    expect(screen.state().draft).toBe("typed");
  });

  test("the visible window asks the thumbnail driver only for those rows (12b's bound)", async () => {
    const h = harness();
    const refs: string[] = [];
    const screen = createSessionScreen({
      sessionId: "s1",
      archived: false,
      title: "Alpha",
      project: "e2e-mac",
      controller: createSessionController<SendableHandle>({
        newSession: (id) => fakeSession(h.sessions, id),
      }),
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1000,
      thumbnails: {
        fetch: async (ref) => {
          refs.push(ref.id);
          return null;
        },
      },
    });
    await screen.open();
    const rows = [
      { kind: "user", images: [{ id: "far", mimeType: "image/png", size: 1 }] },
      ...Array.from({ length: 40 }, () => ({ kind: "assistant" })),
      { kind: "user", images: [{ id: "near", mimeType: "image/png", size: 1 }] },
    ];
    screen.window(40, 41, rows);
    await settle();
    expect(refs).toContain("near");
    // `far` is 40 rows above the window, past `PREFETCH_ROWS`: it is never fetched.
    expect(refs).not.toContain("far");
  });
});

describe("pull-to-refresh (fix/mobile-media-live item 3)", () => {
  /** A handle whose `open` answers with the daemon's history at attach time. */
  function historySession(sessions: FakeSession[], id: string, history: () => SessionActivity) {
    const base = fakeSession(sessions, id);
    return {
      ...base,
      // The controller subscribes AFTER `open()` (`session-controller.ts:196-198`),
      // and the real `watch` delivers what the attach buffered — so the history
      // is handed over on SUBSCRIBE, exactly as a reopened session's is.
      watch: (fn: (activity: SessionActivity) => void) => {
        const off = base.watch(fn);
        fn(history());
        return off;
      },
    } satisfies FakeSession;
  }

  test("a resync REPLACES the rows from the daemon's history, never doubling them (mutation: append instead of replace → 2× the rows)", async () => {
    const now = new Date().toISOString();
    const message = (id: string, content: string) => ({
      id,
      role: "user" as const,
      content,
      createdAt: now,
    });
    let history = [message("m1", "first")];
    const sessions: FakeSession[] = [];
    const screen = createSessionScreen({
      sessionId: "s1",
      archived: false,
      title: "Alpha",
      project: "mac",
      controller: createSessionController<SendableHandle>({
        newSession: (id) =>
          historySession(sessions, id, () => ({
            kind: "history",
            messages: history as never,
            reason: null,
          })),
      }),
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1000,
    });
    await screen.open();
    await settle();
    expect(screen.state().transcript.rows.filter((r) => r.kind === "user")).toHaveLength(1);

    // The daemon gained a message meanwhile (another device's turn): a pull must
    // show it — and show it ONCE (the history is a snapshot, not a delta).
    history = [message("m1", "first"), message("m2", "second")];
    await screen.resync();
    await settle();
    const texts = screen
      .state()
      .transcript.rows.flatMap((r) => (r.kind === "user" ? [r.text] : []));
    expect(texts).toEqual(["first", "second"]);
    // The spinner is off again once the re-attach settled.
    expect(screen.state().refreshing).toBe(false);
  });

  test("a resync that cannot re-attach KEEPS the rows and says so (mutation: drop the notice → a gesture that did nothing is silent)", async () => {
    const sessions: FakeSession[] = [];
    let fail = false;
    const now = new Date().toISOString();
    const screen = createSessionScreen({
      sessionId: "s1",
      archived: false,
      title: "Alpha",
      project: "mac",
      controller: createSessionController<SendableHandle>({
        newSession: (id) => {
          const base = historySession(sessions, id, () => ({
            kind: "history",
            reason: null,
            messages: [{ id: "m1", role: "user", content: "kept", createdAt: now }] as never,
          }));
          if (!fail) {
            return base;
          }
          // The realistic failure: the attach itself cannot be made (the link is
          // down). `session-controller.ts:183-187` turns this into a typed
          // `{ok:false, reason}`; a throw from `newSession` would escape instead.
          return { ...base, open: () => Promise.reject(new Error("no link")) };
        },
      }),
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1000,
    });
    await screen.open();
    await settle();
    expect(screen.state().transcript.rows).toHaveLength(1);

    fail = true;
    await screen.resync();
    await settle();
    // Never an empty transcript, and never a silent no-op.
    expect(screen.state().transcript.rows).toHaveLength(1);
    expect(screen.state().notice).toBe(RESYNC_FAILED_NOTICE);
    expect(screen.state().refreshing).toBe(false);
  });
});

describe("foreground resync (docs/fix/mobile-open-at-end.md, item 2)", () => {
  /** A session whose opens are counted, and whose history the test rewrites. */
  function countingHarness() {
    const sessions: FakeSession[] = [];
    let opens = 0;
    let history: { id: string; role: "user"; content: string; createdAt: string }[] = [];
    let offline = false;
    const screen = createSessionScreen({
      sessionId: "s1",
      archived: false,
      title: "Alpha",
      project: "mac",
      controller: createSessionController<SendableHandle>({
        newSession: (id) => {
          opens += 1;
          const base = fakeSession(sessions, id);
          return {
            ...base,
            open: offline ? () => Promise.reject(new Error("no link")) : base.open,
            watch: (fn: (activity: SessionActivity) => void) => {
              const off = base.watch(fn);
              fn({ kind: "history", messages: history as never, reason: null });
              return off;
            },
          } satisfies FakeSession;
        },
      }),
      broker: new PermissionBroker(undefined, { holdUntilSet: true }),
      now: () => 1000,
    });
    return {
      screen,
      sessions,
      opens: () => opens,
      setHistory: (texts: readonly string[]) => {
        history = texts.map((text, i) => ({
          id: `m${i}`,
          role: "user" as const,
          content: text,
          createdAt: new Date().toISOString(),
        }));
      },
      goOffline: () => {
        offline = true;
      },
      goOnline: () => {
        offline = false;
      },
    };
  }

  test("a return to `active` resyncs once, silently (no pull spinner) [mutation: emit it → a spinner nobody pulled]", async () => {
    const h = countingHarness();
    h.setHistory(["first"]);
    await h.screen.open();
    await settle();
    expect(h.opens()).toBe(1);
    h.setHistory(["first", "second"]);
    // The app leaves and comes back: the mount's own `active` is not a return.
    h.screen.appState("active");
    await settle();
    expect(h.opens()).toBe(1);
    h.screen.appState("background");
    h.screen.appState("active");
    // Silent: the state the screen renders never says "refreshing".
    const seen: boolean[] = [];
    h.screen.subscribe((s) => seen.push(s.refreshing));
    await settle();
    expect(h.opens()).toBe(2);
    expect(seen.every((refreshing) => !refreshing)).toBe(true);
    expect(h.screen.state().transcript.rows.filter((r) => r.kind === "user")).toHaveLength(2);
  });

  test("the `inactive` then `background` pair is ONE departure; a later duplicate `active` is no resync", async () => {
    const h = countingHarness();
    h.setHistory(["first"]);
    await h.screen.open();
    await settle();
    h.screen.appState("inactive");
    h.screen.appState("background");
    h.screen.appState("active");
    await settle(); // the resync settled
    expect(h.opens()).toBe(2); // the mount + ONE resync
    // A duplicate `active` (iOS) is not a new return: the departure was consumed.
    h.screen.appState("active");
    await settle();
    expect(h.opens()).toBe(2);
  });

  test("offline: no foreground resync (the redial re-attach owns the recovery)", async () => {
    const h = countingHarness();
    h.setHistory(["first"]);
    await h.screen.open();
    await settle();
    h.screen.link(false);
    h.screen.appState("background");
    h.screen.appState("active");
    await settle();
    expect(h.opens()).toBe(1);
    expect(h.screen.state().notice).toBeNull();
  });

  test("a screen that never attached (a failed open) does not resync on foreground", async () => {
    const h = countingHarness();
    h.goOffline();
    await h.screen.open();
    await settle();
    expect(h.screen.state().status.phase).toBe("failed");
    h.goOnline();
    h.screen.appState("active");
    h.screen.appState("background");
    h.screen.appState("active");
    await settle();
    // Never attached: the Retry row is what re-attaches, not a silent re-read.
    expect(h.opens()).toBe(1);
  });

  test("a return to `active` reports that it STARTED the re-attach, so the screen can re-arm its silent landing (Review round 1, MEDIUM 3)", async () => {
    const h = countingHarness();
    h.setHistory(["first"]);
    await h.screen.open();
    await settle();
    // The mount's own `active`, then a duplicate: neither re-attaches.
    expect(h.screen.appState("active")).toBe(false);
    h.screen.appState("background");
    // A real return: true, exactly once (the screen arms its landing on it).
    expect(h.screen.appState("active")).toBe(true);
    await settle();
    expect(h.opens()).toBe(2);
    // And a duplicate `active` after it reports nothing (no arming, no resync).
    expect(h.screen.appState("active")).toBe(false);
  });

  test("a foreground that cannot re-attach reports false (offline, or no live attach)", async () => {
    const h = countingHarness();
    h.setHistory(["first"]);
    await h.screen.open();
    await settle();
    h.screen.link(false);
    h.screen.appState("background");
    expect(h.screen.appState("active")).toBe(false); // the link is down: the redial owns recovery
    h.screen.link(true);
    // A screen that never attached (a failed open) has no live attach to re-read.
    const failed = countingHarness();
    failed.goOffline();
    await failed.screen.open();
    await settle();
    failed.goOnline();
    expect(failed.screen.state().status.phase).toBe("failed");
    failed.screen.appState("background");
    expect(failed.screen.appState("active")).toBe(false);
  });

  test("a foreground resync that appends nothing does not move or complain", async () => {
    const h = countingHarness();
    h.setHistory(["first"]);
    await h.screen.open();
    await settle();
    h.screen.appState("background");
    h.screen.appState("active");
    await settle();
    expect(h.opens()).toBe(2);
    expect(h.screen.state().notice).toBeNull();
    expect(h.screen.state().transcript.rows).toHaveLength(1);
  });

  test("a foreground resync WHILE A TURN STREAMS shows each row once (no duplicate rows)", async () => {
    const h = countingHarness();
    h.setHistory(["first"]);
    await h.screen.open();
    await settle();
    // Another device's turn is running (or this one's, read back by the re-attach).
    h.sessions[0]?.emitActivity({
      kind: "turn",
      turnId: "t-live",
      events: (async function* () {
        yield { type: "user_message", text: "streaming" } as SessionEvent;
        yield { type: "text", delta: "an answer" } as SessionEvent;
      })(),
      cancel: () => {},
    });
    await settle();
    const users = () =>
      h.screen.state().transcript.rows.flatMap((r) => (r.kind === "user" ? [r.text] : []));
    expect(users()).toEqual(["first", "streaming"]);
    // The daemon's snapshot already has the streaming prompt: the re-attach's
    // history replaces the rows, so it must not appear a second time.
    h.setHistory(["first", "streaming"]);
    h.screen.appState("background");
    h.screen.appState("active");
    await settle();
    expect(h.opens()).toBe(2);
    expect(users()).toEqual(["first", "streaming"]);
  });

  test("an already-running pull makes the foreground resync a no-op (one re-read, not two)", async () => {
    const h = countingHarness();
    h.setHistory(["first"]);
    await h.screen.open();
    await settle();
    h.screen.appState("background");
    h.screen.appState("active");
    const pull = h.screen.resync();
    await settle();
    await pull;
    expect(h.opens()).toBe(2); // one resync from the foreground edge, the pull's was refused
  });
});
