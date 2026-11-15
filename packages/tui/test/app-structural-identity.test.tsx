/**
 * docs/feat/app-decomposition.md S0b (Fable H2) — CALLBACK IDENTITY: the session
 * link must not re-subscribe on a re-render.
 *
 * `watchSession` (`App.tsx:2361`) is a `useCallback` whose deps (2389–2399) are
 * the port fields it closes over (`setAgents`, `setJobs`, `flushNow`, `armWake`,
 * `subagentsTwoWay`, `setDock`, …), and the mount effect at 2436 re-runs
 * whenever its identity changes — it `watch`es the session again and drops every
 * subscription it held. So a port field that loses its identity rule (a setter
 * turned into an inline lambda, a value that stops being a stable `useState`
 * setter, a dep array narrowed to a whole port object) re-subscribes the session
 * on EVERY render: the backlog is replayed again, the queue/agent/job
 * subscriptions are torn down and rebuilt, and any activity the session raises
 * in the gap is lost.
 *
 * This test counts `watch` subscribe/unsubscribe pairs and `open` calls across
 * re-renders this TUI forces in ordinary ways — typing, a dock clock tick, a
 * resize — and pins ONE subscribe per mounted session. Nothing in it needs a
 * `send`: the re-render is the whole trigger.
 *
 * The deps that the hooks slices must preserve field by field (H2 (1)); a slice
 * whose port hands over a fresh object per render re-subscribes and this goes
 * red (M2: `watchSession` loses its `useCallback`, so its identity is new on
 * every render).
 */
import { describe, expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import type { SessionActivity } from "../src/turn-feed.ts";
import { inertSession } from "./session-stub.ts";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Counts {
  /** `watch` subscriptions made. */
  watches: number;
  /** …and torn down. */
  releases: number;
  /** `open` calls (the eager open a watcher asks for). */
  opens: number;
}

/**
 * A session that counts what a re-subscribe looks like from its side: a new
 * `watch` (and thus a replayed backlog), a released one, an `open`.
 */
function fake(counts: Counts): SessionController {
  return {
    ...inertSession(),
    watch(_listener: (activity: SessionActivity) => void) {
      counts.watches += 1;
      let released = false;
      return () => {
        if (!released) {
          released = true;
          counts.releases += 1;
        }
      };
    },
    open() {
      counts.opens += 1;
      return Promise.resolve();
    },
    onQueued() {
      return () => {};
    },
    onSubagents(listener: (rows: readonly never[]) => void) {
      listener([]);
      return () => {};
    },
    onJobs(listener: (report: { rows: readonly never[]; count: number }) => void) {
      listener({ rows: [], count: 0 });
      return () => {};
    },
    onSubagentNotify() {
      return () => {};
    },
    onSubagentMessage() {
      return () => {};
    },
    context() {
      return Promise.resolve({ used: 1, exact: true });
    },
    skills() {
      return Promise.resolve({ list: [], mode: "hot" });
    },
    ownsTurn: () => true,
  } as unknown as SessionController;
}

describe("S0b callback identity: one session link per session, across re-renders", () => {
  test("identity: typing, a dock clock tick and a resize never re-subscribe the session", async () => {
    const counts: Counts = { watches: 0, releases: 0, opens: 0 };
    const app = render(<App createSession={() => fake(counts)} model="m" cwd="/tmp/work" />);
    await delay(60);
    // Mounted: one watch, one eager open — the baseline this test holds to.
    expect(counts).toEqual({ watches: 1, releases: 0, opens: 1 });

    // (1) A re-render from the input: typing is a `useState` update per chunk.
    for (const chunk of ["a", "b", "c"]) {
      app.stdin.write(chunk);
      await delay(15);
    }
    expect(counts.watches).toBe(1);
    expect(counts.releases).toBe(0);

    // (2) A re-render from a timer this TUI owns: the status bar's clock.
    await delay(60);
    expect(counts.watches).toBe(1);

    // (3) A re-render from a resize (the App re-measures and re-lays out).
    Object.defineProperty(app.stdout, "columns", { value: 79, configurable: true });
    app.stdout.emit("resize");
    await delay(60);
    expect(counts.watches).toBe(1);
    // The frame did re-render (so the assertions above are not vacuous: these
    // renders really happened).
    expect(app.lastFrame() ?? "").toContain("abc");

    // One link, never torn down and rebuilt: exactly one subscribe, no release,
    // one eager open — however many renders happened in between.
    expect(counts).toEqual({ watches: 1, releases: 0, opens: 1 });
    app.unmount();
    await delay(30);
    // …and the unmount releases exactly the one it took (once, not once per
    // render: the counter is per-subscription and the session saw only one).
    expect(counts.releases).toBe(1);
  });
});
