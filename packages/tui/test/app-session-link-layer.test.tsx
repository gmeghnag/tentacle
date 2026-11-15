/**
 * docs/feat/app-decomposition.md S9b — the SESSION LINK executes through
 * `useSessionLink`.
 *
 * These are the App-seam cases: the hook is exercised through the REAL `App`
 * (ink-testing-library), so what is pinned is the behaviour the move could have
 * broken — never the hook's internals. Each case names the plan's failure mode
 * for this slice and the mutation that turns it red:
 *
 * 1. **Freshness (H3) — a ref read must stay a ref read.** `onActivity` decides
 *    `inFlight` from `streamCtrlRef`/`sendNowRef`/`warmingRef` at the moment the
 *    activity ARRIVES, and the held/consumed verdict follows from it. Wired to a
 *    render value instead, an activity raised with no render between the two is
 *    decided on a stale frame.
 * 2. **The hold/lost latch is the driver's, not the hook's** (`heldRef`): an
 *    activity that arrives mid-turn is HELD and reaches the frame only when the
 *    turn settles — a hook-private copy would lose it silently.
 * 3. **A `history` replaces, appends or only notices** (`historyAction`): the
 *    `/clear` count and the "own vs another device" notice still work through
 *    the port.
 * 4. **The cycle keeps its late binding** (`swapRef`, `onActivityRef`): a
 *    `closed` activity reaches the handler through the ref, and moves the view
 *    through the swap ref.
 * 5. **`watchSession` installs and tears down every subscription** of a follow.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { render } from "ink-testing-library";
import { App, type SessionController, type SessionDirectory } from "../src/App.tsx";
import type { BackgroundAgentRow } from "../src/background-view.ts";
import type { DaemonQueue } from "../src/queued.ts";
import type { SessionEvent } from "../src/state.ts";
import type { SessionActivity } from "../src/turn-feed.ts";
import { inertSession } from "./session-stub.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
const strip = (s: string | undefined) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR stripping
  (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");
const ENTER = "\r";

/** Wait (bounded) until `cond` holds: beats a fixed sleep for a settle. */
async function until(cond: () => boolean, ms = 1500): Promise<void> {
  const start = Date.now();
  while (!cond() && Date.now() - start < ms) {
    await delay(10);
  }
}

/** An event stream the test drives: `push`, then `end`. */
function stream() {
  const queue: SessionEvent[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  const events: AsyncIterable<SessionEvent> = {
    async *[Symbol.asyncIterator]() {
      while (true) {
        while (queue.length > 0) {
          const next = queue.shift();
          if (next) yield next;
        }
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
  };
}

/**
 * A session that logs what a follow does from its side: the subscribe/unsubscribe
 * pairs, the eager open, and the per-session feeds a follow installs.
 */
function fake() {
  const log = {
    watches: 0,
    releases: 0,
    opens: 0,
    queues: 0,
    queueReleases: 0,
    agents: 0,
    jobs: 0,
    notifies: 0,
    messages: 0,
    sends: [] as string[],
  };
  let listener: ((a: SessionActivity) => void) | null = null;
  const sub =
    (slot: "queues" | "agents" | "jobs" | "notifies" | "messages", released?: () => void) => () => {
      log[slot] += 1;
      let done = false;
      return () => {
        if (!done && released !== undefined) {
          done = true;
          released();
        }
      };
    };
  const ctrl = {
    ...inertSession(),
    async *send(prompt: string, signal?: AbortSignal) {
      log.sends.push(prompt);
      if (prompt === "hold") {
        yield { type: "text", delta: "working" };
        await new Promise<void>((resolve) => {
          signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        yield { type: "turn_end", reason: "cancelled" };
        return;
      }
      yield { type: "text", delta: `reply to ${prompt}` };
      yield { type: "turn_end", reason: "end_turn" };
    },
    watch(l: (a: SessionActivity) => void) {
      log.watches += 1;
      listener = l;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          log.releases += 1;
        }
        if (listener === l) {
          listener = null;
        }
      };
    },
    open() {
      log.opens += 1;
      return Promise.resolve();
    },
    onQueued(_l: (q: DaemonQueue) => void) {
      return sub("queues", () => {
        log.queueReleases += 1;
      })();
    },
    onSubagents() {
      return sub("agents")();
    },
    onJobs() {
      return sub("jobs")();
    },
    onSubagentNotify() {
      return sub("notifies")();
    },
    onSubagentMessage() {
      return sub("messages")();
    },
    ownsTurn: () => true,
  };
  return {
    ctrl: ctrl as unknown as SessionController,
    log,
    raise: (a: SessionActivity) => listener?.(a),
  };
}

/** Mount the App over one fake session. */
function mount(extra: Record<string, unknown> = {}) {
  const f = fake();
  const app = render(
    <App
      createSession={() => f.ctrl}
      model="m"
      cwd="/tmp/work"
      permissions={new PermissionBroker()}
      {...extra}
    />,
  );
  return { app, ...f };
}

async function type(stdin: { write(d: string): void }, text: string, settle = 80) {
  stdin.write(text);
  await delay(20);
  stdin.write(ENTER);
  await delay(settle);
}

describe("S9b: a follow installs every subscription, then drops them", () => {
  test("the mount watch installs the session's feeds and the eager open (watch FIRST)", async () => {
    // Mutation: `watchSession` skips one subscription (an `onJobs`/`onSubagents`
    // line deleted) → that count stays 0 and the dock never sees its rows.
    const r = mount();
    await delay(60);
    expect(r.log.watches).toBe(1);
    expect(r.log.opens).toBe(1);
    expect(r.log.queues).toBe(1);
    expect(r.log.agents).toBe(1);
    expect(r.log.jobs).toBe(1);
    expect(r.log.notifies).toBe(1);
    expect(r.log.messages).toBe(1);
    r.app.unmount();
  });

  test("unmounting releases the activity subscription (no leak past the frame)", async () => {
    // Mutation: the mount effect stops returning its teardown → the release
    // count stays 0 and a late activity reaches an unmounted tree.
    const r = mount();
    await delay(60);
    r.app.unmount();
    await delay(20);
    expect(r.log.releases).toBeGreaterThanOrEqual(1);
  });
});

describe("S9b: onActivity executes the pure decision, on the live latches (H3)", () => {
  test("a history with no turn running REPLACES the transcript (historyAction)", async () => {
    // Mutation: `historyAction`'s verdict collapsed to a constant → the daemon's
    // history is never applied and the reply never reaches the frame.
    const r = mount();
    await delay(60);
    r.raise({
      kind: "history",
      reason: null,
      messages: [{ role: "assistant", content: "FROM THE DAEMON" }],
    } as unknown as SessionActivity);
    await delay(80);
    expect(strip(r.app.lastFrame())).toContain("FROM THE DAEMON");
    r.app.unmount();
  });

  test("a turn raised while IDLE streams through the ONE loop", async () => {
    // Mutation: `nextStep`'s `consume` arm dropped (every turn held) → the
    // foreign turn's text never reaches the frame.
    const r = mount();
    await delay(60);
    const s = stream();
    r.raise({ kind: "turn", turnId: "other", events: s.events, cancel: () => {} });
    await delay(30);
    s.push({ type: "text", delta: "FOREIGN TEXT" });
    await delay(80);
    expect(strip(r.app.lastFrame())).toContain("FOREIGN TEXT");
    s.end();
    r.app.unmount();
  });

  test("an activity raised MID-TURN is HELD, and reaches the frame only at the settle", async () => {
    // Mutation: the hold arm writes a hook-private array instead of `heldRef`
    // (or drops the push) → the held activity is lost, never drained.
    const r = mount();
    await delay(60);
    await type(r.app.stdin, "hold", 60); // my own turn, still streaming
    expect(strip(r.app.lastFrame())).toContain("working");
    r.raise({
      kind: "history",
      reason: null,
      messages: [{ role: "assistant", content: "HELD HISTORY" }],
    } as unknown as SessionActivity);
    await delay(60);
    // Held: the frame still shows my turn, not the held history.
    expect(strip(r.app.lastFrame())).not.toContain("HELD HISTORY");
    // Settle my turn: the drain applies it.
    r.app.stdin.write("\x1b"); // Esc aborts the turn
    await until(() => strip(r.app.lastFrame()).includes("HELD HISTORY"));
    expect(strip(r.app.lastFrame())).toContain("HELD HISTORY");
    r.app.unmount();
  });

  test("a second follow tears the previous session's queue subscription down", async () => {
    // Mutation: the `queueSubRef.current?.()` teardown dropped from
    // `watchSession` → the old session's `onQueued` is never released, so two
    // sessions' queues race into one view (the plan's "silent drop" class).
    // The fake records the RELEASE, so the case proves the teardown itself.
    const journal: string[] = [];
    const first = fake();
    const second = fake();
    first.ctrl.detach = () => {
      journal.push("detach");
      return Promise.resolve();
    };
    const dir: SessionDirectory = {
      list: () =>
        Promise.resolve({
          sessions: [
            {
              id: "B",
              title: "title B",
              updatedAt: Date.now(),
              running: false,
              attached: 0,
              archived: false,
            },
          ],
          more: false,
        }),
      open: () => second.ctrl,
      remove: () => Promise.resolve(),
    };
    let n = 0;
    const app = render(
      <App
        createSession={() => {
          n += 1;
          return n === 1 ? first.ctrl : second.ctrl;
        }}
        model="m"
        cwd="/tmp/work"
        permissions={new PermissionBroker()}
        sessions={dir}
      />,
    );
    await delay(60);
    expect(first.log.queues).toBe(1);
    // A `/sessions` switch to a target the directory hands back.
    app.stdin.write("/sessions");
    await delay(60);
    app.stdin.write(ENTER);
    await until(() => second.log.queues === 1 || journal.length > 0);
    app.stdin.write(ENTER);
    await until(() => first.log.queueReleases === 1 && second.log.queues === 1, 600);
    expect(journal).toEqual(["detach"]);
    expect(first.log.queueReleases).toBe(1);
    expect(first.log.queueReleases).toBe(1);
    expect(second.log.queues).toBe(1);
    app.unmount();
  });

  test("a `closed` activity moves the view through swapRef (the cycle keeps late binding)", async () => {
    // Mutation: `swapRef.current?.(...)` replaced by a bare `makeSession()` (the
    // swap dropped) → the notice still shows, but the view never MOVES to a
    // fresh session. The exact property is the FOLLOW, not the notice: a new
    // session gets watched (so its `watch` count rises). Asserting only the
    // notice would be the §2 trap — a correlated property, not the one the
    // mutation breaks.
    const r = mount();
    await delay(60);
    await type(r.app.stdin, "hello", 80);
    const before = r.log.watches;
    r.raise({ kind: "closed", reason: "closed" });
    await until(() => r.log.watches > before);
    // Moved: the fresh session is being followed (a new subscribe).
    expect(r.log.watches).toBeGreaterThan(before);
    // …and the closure is said, for a runtime with no `/sessions` directory.
    expect(strip(r.app.lastFrame()).toLowerCase()).toContain("another");
    r.app.unmount();
  });
});

describe("S9b: swapSession and switchTo are the ONE way the view moves", () => {
  test("a follow RESETS the new session's own views: a live sub-agent row goes with the old one", async () => {
    // Mutation: the per-session reset (`setAgents(undefined)`, `setDaemonQueue`,
    // `setDock(resetDock())`) dropped from `watchSession` → the old session's
    // dock rows survive into the new one: rows of a session this TUI no longer
    // follows, which the plan calls a silent wrong-state (Failure modes).
    // The observation is the FRAME: the child's description must leave it.
    const rows = [
      {
        id: "sa-1",
        agentType: "explore",
        description: "OLDSESSIONAGENT",
        state: "running" as const,
        toolUses: 1,
        tokens: 10,
      },
    ];
    const holder: { agents: ((r: readonly BackgroundAgentRow[]) => void) | null } = {
      agents: null,
    };
    const first = fake();
    first.ctrl.onSubagents = (l: (r: readonly BackgroundAgentRow[]) => void) => {
      holder.agents = l;
      l(rows);
      return () => {};
    };
    const second = fake();
    first.ctrl.detach = () => Promise.resolve();
    const dir: SessionDirectory = {
      list: () =>
        Promise.resolve({
          sessions: [
            {
              id: "B",
              title: "title B",
              updatedAt: Date.now(),
              running: false,
              attached: 0,
              archived: false,
            },
          ],
          more: false,
        }),
      open: () => second.ctrl,
      remove: () => Promise.resolve(),
    };
    let n = 0;
    const app = render(
      <App
        createSession={() => {
          n += 1;
          return n === 1 ? first.ctrl : second.ctrl;
        }}
        model="m"
        cwd="/tmp/work"
        permissions={new PermissionBroker()}
        sessions={dir}
      />,
    );
    await delay(80);
    holder.agents?.(rows); // the old session reports a running child
    await delay(80);
    // The dock pill counts it ("1 agent ↓"): that is the frame's observable.
    expect(strip(app.lastFrame())).toContain("1 agent");
    // Follow the other session.
    app.stdin.write("/sessions");
    await delay(60);
    app.stdin.write(ENTER);
    await until(() => second.log.watches >= 1);
    app.stdin.write(ENTER);
    // The wait is the settle only; the ASSERTION is the property, so a reset
    // that never happens still fails (a bare `until` would swallow it).
    await until(() => !strip(app.lastFrame()).includes("1 agent"), 400);
    expect(second.log.watches).toBeGreaterThanOrEqual(1);
    expect(strip(app.lastFrame())).not.toContain("1 agent");
    app.unmount();
  });

  test("a `/sessions` switch detaches the old, opens the target, and moves the view", async () => {
    // Mutation: `switchTo` swapped before detaching (or dropped the detach) →
    // two attachments, and the journal order changes.
    const journal: string[] = [];
    const first = fake();
    const second = fake();
    first.ctrl.detach = () => {
      journal.push("detach");
      return Promise.resolve();
    };
    const dir: SessionDirectory = {
      list: () =>
        Promise.resolve({
          sessions: [
            {
              id: "B",
              title: "title B",
              updatedAt: Date.now(),
              running: false,
              attached: 0,
              archived: false,
            },
          ],
          more: false,
        }),
      open: (id, reopen) => {
        journal.push(`dir.open:${id}:${reopen}`);
        return second.ctrl;
      },
      remove: () => Promise.resolve(),
    };
    let n = 0;
    const app = render(
      <App
        createSession={() => {
          n += 1;
          return n === 1 ? first.ctrl : second.ctrl;
        }}
        model="m"
        cwd="/tmp/work"
        permissions={new PermissionBroker()}
        sessions={dir}
      />,
    );
    await delay(60);
    // `/sessions`, then Enter on the first row (the panel's own key path).
    app.stdin.write("/sessions");
    await delay(40);
    app.stdin.write(ENTER);
    await until(() => journal.length > 0);
    app.stdin.write(ENTER);
    await until(() => second.log.watches >= 1);
    expect(journal).toContain("detach");
    expect(journal.some((j) => j.startsWith("dir.open:B:"))).toBe(true);
    // Detach FIRST, then open: the other order would hold two attachments.
    expect(journal.indexOf("detach")).toBeLessThan(journal.findIndex((j) => j.startsWith("dir")));
    // The new session is followed (its own subscriptions are installed).
    expect(second.log.watches).toBeGreaterThanOrEqual(1);
    app.unmount();
  });
});
