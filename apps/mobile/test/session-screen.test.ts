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
import { FAILED_NOTICE, REFUSED_NOTICE } from "../src/composer.ts";
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

  test("a route flagged `archived` still attaches WITHOUT reopen (browsing never revives — Owner Q4)", async () => {
    // The flag only decides the BANNER when the daemon refuses the plain attach;
    // it must never be a reason to pass `reopen`. Mutation: pass `reopen:
    // deps.archived` → `opens` becomes `[true]` and this test is red.
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

  test("a link down keeps the draft and disables Send (F12)", async () => {
    const h = harness();
    const { screen } = h.make();
    await screen.open();
    screen.setDraft("kept");
    screen.link(false);
    expect(screen.state().view.banner?.kind).toBe("reconnecting");
    expect(screen.state().view.composer.button).toBe("disabled");
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
