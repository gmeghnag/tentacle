/**
 * The session screen's slices (docs/feat/mobile-ui-fluidity-s3.md): a streamed
 * delta changes ONLY the transcript's slice, so the header, the composer, the
 * hub and the sheets are not woken by the stream. Each fact wakes exactly its
 * slices; a publish never reorders or revives after dispose.
 */
import { describe, expect, test } from "bun:test";
import type { SessionActivity, SessionEvent } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import { createSessionController } from "../src/session-controller.ts";
import {
  type SendableHandle,
  type SessionScreenState,
  createSessionScreen,
} from "../src/session-screen-controller.ts";
import {
  SLICE_FACTS,
  SLICE_KEYS,
  type SliceFact,
  type SliceKey,
  createSessionStore,
  deriveSlices,
  keepSlices,
  sameData,
} from "../src/session-store.ts";

async function settle(): Promise<void> {
  for (let i = 0; i < 50; i += 1) {
    await Promise.resolve();
  }
}

function fakeClock() {
  const clock = { at: 1000 };
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => clock.at,
    schedule: (fn: () => void, ms: number) => {
      const timer = { at: clock.at + ms, fn, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    advance: (ms: number): void => {
      clock.at += ms;
      for (const timer of timers) {
        if (timer.live && timer.at <= clock.at) {
          timer.live = false;
          timer.fn();
        }
      }
    },
  };
}

/** The real controller, WITH an info port (the app always has one). */
function harness() {
  const time = fakeClock();
  let watcher: ((activity: SessionActivity) => void) | null = null;
  const published: SessionScreenState[] = [];
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
    now: time.now,
    schedule: time.schedule,
    onChange: (state) => published.push(state),
    info: () => ({
      daemon: () => ({ version: "1.4.0", model: "m", contextWindow: 200_000 }),
      now: () => 1,
      computerName: () => "e2e-mac",
      title: () => "Alpha",
      phase: () => "open",
      sessionId: "s1",
      mcpStatus: () => Promise.resolve([]),
      sessionList: () => Promise.resolve({ sessions: [] }),
      session: () => ({
        skills: () => Promise.resolve({ slash: [], skills: [], problems: [], moreProblems: 0 }),
        context: () => Promise.resolve({ used: 1, exact: true }),
      }),
    }),
  });
  return { screen, published, time, emit: (a: SessionActivity) => watcher?.(a) };
}

function pushedTurn() {
  const queue: SessionEvent[] = [];
  let wake: (() => void) | null = null;
  const events = (async function* () {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  })();
  return {
    activity: { kind: "turn", turnId: "t1", events, cancel: () => {} } as SessionActivity,
    push: (e: SessionEvent): void => {
      queue.push(e);
      wake?.();
    },
  };
}

/** A real, settled state to build fixtures from. */
async function baseState(): Promise<SessionScreenState> {
  const h = harness();
  await h.screen.open();
  await settle();
  return h.screen.state();
}

const OTHERS: readonly SliceKey[] = ["header", "composer", "hub", "sheets"];

describe("a streamed delta wakes only the transcript", () => {
  test("30 reasoning deltas: `rows` is new at every publish; the other slices are the same objects", async () => {
    const h = harness();
    await h.screen.open();
    await settle();
    const turn = pushedTurn();
    h.emit(turn.activity);
    await settle();
    for (let i = 0; i < 2; i += 1) {
      turn.push({ type: "reasoning", delta: "warm " } as SessionEvent);
      await settle();
      h.time.advance(200);
      await settle();
    }
    const store = h.screen.sessionStore();
    const kept = new Map(SLICE_KEYS.map((key) => [key, store.get(key)]));
    const woken = new Map<SliceKey, number>();
    for (const key of SLICE_KEYS) {
      store.subscribe(key, () => woken.set(key, (woken.get(key) ?? 0) + 1));
    }
    let publishes = 0;
    let rows = store.get("rows");
    const stale: string[] = [];
    store.onPublish(() => {
      publishes += 1;
      if (store.get("rows") === rows) {
        stale.push(`rows kept at publish ${publishes}`);
      }
      rows = store.get("rows");
      for (const key of OTHERS) {
        if (store.get(key) !== kept.get(key)) {
          stale.push(`${key} changed at publish ${publishes}`);
        }
      }
    });
    for (let i = 0; i < 30; i += 1) {
      turn.push({ type: "reasoning", delta: `w${i} ` } as SessionEvent);
      await settle();
      h.time.advance(50);
      await settle();
    }
    expect(publishes).toBeGreaterThanOrEqual(10);
    expect(stale).toEqual([]);
    expect(woken.get("rows") ?? 0).toBe(publishes);
    for (const key of OTHERS) {
      expect([key, woken.get(key) ?? 0]).toEqual([key, 0]);
    }
    // Non-vacuity: the real app's `info` IS rebuilt at every state read.
    expect(h.screen.state().info).not.toBeNull();
    expect(h.screen.state().info).not.toBe(h.screen.state().info);
  });
});

/** A new, different value for one fact of `base`. */
function changed(base: SessionScreenState, fact: SliceFact): SessionScreenState {
  if (fact === "transcript") {
    // A part of the transcript no other slice derives from.
    return { ...base, transcript: { ...base.transcript, unsupported: ["new-kind"] } };
  }
  const marker = { changed: fact };
  if (fact === "sheet") {
    return { ...base, sheet: { kind: "idle", ...marker } as never };
  }
  if (fact === "view.composer") {
    // `running` is derived into the header: keep it as it was.
    return { ...base, view: { ...base.view, composer: { ...base.view.composer, ...marker } } };
  }
  if (fact.startsWith("view.")) {
    return { ...base, view: { ...base.view, [fact.slice(5)]: marker } };
  }
  return { ...base, [fact]: marker };
}

const changedSlices = (a: SessionScreenState, b: SessionScreenState): SliceKey[] => {
  const prev = deriveSlices(a);
  const next = keepSlices(prev, deriveSlices(b));
  return SLICE_KEYS.filter((key) => next[key] !== prev[key]);
};

describe("every fact wakes exactly its slices", () => {
  test("an equal state keeps every slice", async () => {
    const base = await baseState();
    expect(changedSlices(base, { ...base, view: { ...base.view } })).toEqual([]);
  });

  test("the table covers every field of the state and of its view", async () => {
    const base = await baseState();
    const fields = [
      ...Object.keys(base).filter((key) => key !== "view"),
      ...Object.keys(base.view).map((key) => `view.${key}`),
    ];
    // `view` may omit optional members; every present one must be classified.
    expect(fields.filter((f) => !(f in SLICE_FACTS))).toEqual([]);
  });

  for (const fact of Object.keys(SLICE_FACTS) as SliceFact[]) {
    test(fact, async () => {
      const base = await baseState();
      expect(changedSlices(base, changed(base, fact))).toEqual(
        SLICE_KEYS.filter((key) => (SLICE_FACTS[fact] as readonly SliceKey[]).includes(key)),
      );
    });
  }

  // The expected table, spelled out: moving a fact in `SLICE_FACTS` alone fails here.
  test("what the panes read is in their slice", async () => {
    const base = await baseState();
    const expected: [SliceFact, SliceKey[]][] = [
      ["draft", ["composer"]],
      ["notice", ["composer"]],
      ["riskStrip", ["composer"]],
      ["compose", ["composer", "sheets"]],
      ["view.title", ["header"]],
      ["view.headerContext", ["header"]],
      ["askQueued", ["header", "sheets"]],
      ["askAutoAccepted", ["sheets"]],
      ["catalogue", ["hub"]],
      ["info", ["hub", "sheets"]],
      ["schedules", ["hub", "sheets"]],
      ["commands", ["hub", "sheets"]],
    ];
    for (const [fact, keys] of expected) {
      expect([fact, changedSlices(base, changed(base, fact))]).toEqual([fact, keys]);
    }
  });

  test("the transcript's derived facts wake their readers", async () => {
    const base = await baseState();
    const down = { ...base, transcript: { ...base.transcript, link: "down" as const } };
    expect(changedSlices(base, down)).toEqual(["rows", "header", "hub"]);
    const turn = { ...base, transcript: { ...base.transcript, turn: { turnId: "t9" } as never } };
    expect(changedSlices(base, turn)).toEqual(["rows", "hub"]);
    const report = {
      kind: "notice",
      key: "n1",
      text: "done",
      note: { kind: "subagent_report", id: "c1" },
    } as never;
    const reported = { ...base, transcript: { ...base.transcript, rows: [report] } };
    expect(changedSlices(base, reported)).toEqual(["rows", "hub"]);
    // The same report in a new rows array: nobody but the transcript cares.
    const again = { ...base, transcript: { ...base.transcript, rows: [report] } };
    expect(changedSlices(reported, again)).toEqual(["rows"]);
  });
});

describe("sameData is structural, and never says equal when it cannot know", () => {
  test("equal plain data", () => {
    expect(sameData({ a: [1, { b: "x", c: null }] }, { a: [1, { b: "x", c: null }] })).toBe(true);
  });
  test("differences", () => {
    expect(sameData({ a: [1, { b: "x" }] }, { a: [1, { b: "y" }] })).toBe(false);
    expect(sameData([1], [1, 2])).toBe(false);
    expect(sameData({ a: undefined }, {})).toBe(false);
    expect(sameData({ a: undefined }, { b: undefined })).toBe(false);
    expect(sameData([], {})).toBe(false);
    expect(sameData(null, {})).toBe(false);
  });
  test("functions, Maps and class instances only equal themselves", () => {
    class Box {
      readonly v = 1;
    }
    const f = () => 1;
    expect(sameData(f, () => 1)).toBe(false);
    expect(sameData(new Map([[1, 2]]), new Map([[1, 2]]))).toBe(false);
    expect(sameData(new Set(), new Set())).toBe(false);
    expect(sameData(new Box(), new Box())).toBe(false);
    expect(sameData({ f }, { f })).toBe(true);
  });
});

describe("the store's publishes", () => {
  async function storeOver() {
    const time = fakeClock();
    let state = await baseState();
    const store = createSessionStore({
      read: () => state,
      clock: time.now,
      schedule: time.schedule,
    });
    return {
      store,
      time,
      set: (draft: string) => {
        state = { ...state, draft };
      },
    };
  }

  test("100 stream publishes over 1 s fire at most 11 times; `now` absorbs a pending one", async () => {
    const h = await storeOver();
    let fires = 0;
    h.store.onPublish(() => {
      fires += 1;
    });
    for (let i = 0; i < 100; i += 1) {
      h.store.publish("stream");
      h.time.advance(10);
    }
    expect(fires).toBeLessThanOrEqual(11);
    expect(fires).toBeGreaterThanOrEqual(9);
    h.time.advance(200);
    h.store.publish("stream"); // leading edge
    h.store.publish("stream"); // pending
    const before = fires;
    h.store.publish("now");
    h.time.advance(200);
    expect(fires).toBe(before + 1);
  });

  test("a publish raised while publishing is queued: nobody gets an older state after a newer one", async () => {
    const h = await storeOver();
    const first: string[] = [];
    const second: string[] = [];
    const slice: string[] = [];
    h.store.get("composer");
    h.store.onPublish((s) => {
      first.push(s.draft);
      if (s.draft === "a") {
        h.set("b");
        h.store.publish("now");
      }
    });
    h.store.onPublish((s) => second.push(s.draft));
    h.store.subscribe("composer", () => slice.push(h.store.get("composer").draft));
    h.set("a");
    h.store.publish("now");
    expect(first).toEqual(["a", "b"]);
    expect(second).toEqual(["a", "b"]);
    expect(slice).toEqual(["a", "b"]);
  });

  test("dispose drops a pending publish, and later ones do nothing", async () => {
    const h = await storeOver();
    let fires = 0;
    h.store.onPublish(() => {
      fires += 1;
    });
    h.store.publish("stream");
    h.store.publish("stream");
    h.store.dispose();
    h.time.advance(500);
    h.store.publish("now");
    h.store.publish("stream");
    expect(fires).toBe(1);
  });
});

describe("the whole-state contract is kept (decision 3)", () => {
  test("`subscribe` and `onChange` fire on every publish, before the slice listeners", async () => {
    const h = harness();
    await h.screen.open();
    await settle();
    const order: string[] = [];
    h.screen.subscribe((s) => order.push(`whole:${s.draft}`));
    h.screen.sessionStore().subscribe("composer", () => order.push("slice"));
    const before = h.published.length;
    h.screen.setDraft("x");
    expect(h.published.length).toBe(before + 1);
    expect(order).toEqual(["whole:x", "slice"]);
  });
});
