/**
 * docs/fix/clear-connect-unbound.md — the session the App drives is sometimes a
 * CLASS instance, not an object literal of closures: under `connect` the TUI is
 * handed the `RemoteSession` itself (`connect.ts` `createSession`), and its
 * methods read `this` (`RemoteSession.clear` → `this.openForReset`,
 * `jobOutput` → `this.id`/`this.client`). A method TAKEN OFF that object and
 * called on its own (`const { clear } = session; clear()`) loses `this` and
 * throws — `/clear` on a `connect` session answered
 * `⏺ /clear failed: undefined is not an object (evaluating 'this.openForReset')
 * — still in this session`.
 *
 * The local runtime's `persistingController` is an object literal whose methods
 * are closures over `inner`, so the bug was invisible on every existing test
 * (all of them fake the session that way). These tests fake it as the CLASS it
 * really is under `connect`.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { App, type SessionController } from "../src/App.tsx";
import { renderAt } from "./real-term.tsx";

const DOWN = "\u001B[B";
const ENTER = "\r";

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const strip = (s: string | undefined) =>
  // biome-ignore lint/suspicious/noControlCharactersInRegex: SGR stripping
  (s ?? "").replace(/\x1b\[[0-9;]*m/g, "");

/** How many times each method actually RAN (a lost `this` throws before the body). */
interface Ran {
  opens: number;
  clears: number;
  compacts: number;
  reads: number;
}

/**
 * A session shaped like `RemoteSession`: a class instance whose every method
 * touches `this`. Not `as SessionController` alone — the `this` reads are what
 * make an unbound call throw, exactly as the real one does.
 */
class ClassSession {
  readonly ran: Ran = { opens: 0, clears: 0, compacts: 0, reads: 0 };
  /** The wire id: null before the first open, as `RemoteSession`'s is. */
  id: string | null = null;
  private listener: ((activity: never) => void) | null = null;

  async *send(prompt: string): AsyncIterable<never> {
    this.id ??= "s-1";
    yield { type: "text", delta: `reply to ${prompt}` } as never;
    yield { type: "turn_end", reason: "end_turn" } as never;
  }

  watch(listener: (activity: never) => void): () => void {
    this.listener = listener;
    return () => {
      this.listener = null;
    };
  }

  raise(activity: unknown): void {
    this.listener?.(activity as never);
  }

  /** The open a reset needs (`RemoteSession.openForReset`). */
  async openForReset(): Promise<void> {
    this.ran.opens += 1;
    this.id ??= "s-1";
  }

  /** `RemoteSession.clear` (packages/client/src/remote-session.ts:780). */
  async clear(): Promise<{ before: number; after: number }> {
    await this.openForReset();
    if (!this.id) {
      return { before: 0, after: 0 };
    }
    this.ran.clears += 1;
    return { before: 2, after: 0 };
  }

  /** `RemoteSession.compact` (packages/client/src/remote-session.ts:821). */
  async compact(): Promise<{ before: number; after: number }> {
    await this.openForReset();
    if (!this.id) {
      return { before: 0, after: 0 };
    }
    this.ran.compacts += 1;
    return { before: 8, after: 3 };
  }

  /** `RemoteSession.jobOutput` (packages/client/src/remote-session.ts:561). */
  jobOutput(jobId: string): Promise<{
    found: true;
    jobId: string;
    status: "running";
    output: string[];
  }> {
    if (!this.id) {
      return Promise.resolve({ found: false, jobId, reason: "not open" }) as never;
    }
    this.ran.reads += 1;
    return Promise.resolve({
      found: true,
      jobId: `${this.id}/${jobId}`,
      status: "running",
      output: ["TAIL of the job", ""],
    });
  }

  killJob(): Promise<{ killed: boolean }> {
    return Promise.resolve({ killed: true });
  }

  /** The dock's live job list; a test replaces it (optional on the controller). */
  onJobs?: SessionController["onJobs"];

  close(): void {
    this.id = null;
  }
}

async function mount(session: SessionController, columns = 120) {
  const app = renderAt(
    <App
      createSession={() => session}
      model="remote"
      cwd="ws://daemon"
      permissions={new PermissionBroker()}
    />,
    { columns, rows: 30 },
  );
  await delay(80);
  return app;
}

async function type(app: { stdin: { write(d: string): void } }, text: string) {
  app.stdin.write(text);
  await delay(20);
  app.stdin.write(ENTER);
  await delay(80);
}

describe("a CLASS session (the `connect` path) keeps its `this`", () => {
  test("/clear clears it — no `this.openForReset` TypeError, no failure notice", async () => {
    // Mutation: `const { clear } = session; clear()` (App.runClear before this
    // fix) → the method runs with `this === undefined`, `ran.clears` stays 0 and
    // the frame says `/clear failed: undefined is not an object`.
    const session = new ClassSession();
    const app = await mount(session);
    await type(app, "hello");
    expect(strip(app.lastFrame())).toContain("› hello");
    await type(app, "/clear");
    // The open came first, then the clear — both on the session, in that order.
    expect(session.ran.opens).toBeGreaterThanOrEqual(1);
    expect(session.ran.clears).toBe(1);
    const frame = strip(app.lastFrame());
    expect(frame).not.toContain("/clear failed");
    // The cleared history arrives through the activity, not the command.
    session.raise({ kind: "history", messages: [], reason: "clear" });
    await delay(60);
    expect(strip(app.lastFrame())).not.toContain("› hello");
    app.unmount();
  });

  test("/compact compacts it — the same `this`-bound shape, pinned", async () => {
    // Guard, not a red-on-main test (App calls `/compact` on the session
    // already): a future refactor that takes `compact` off the object fails here.
    const session = new ClassSession();
    const app = await mount(session);
    await type(app, "hello");
    await type(app, "/compact");
    await delay(80);
    expect(session.ran.compacts).toBe(1);
    expect(strip(app.lastFrame())).not.toContain("Compaction isn't available");
    app.unmount();
  });

  test("a job's drawer reads its output — `this.id`/`this.client` intact", async () => {
    // Mutation: `const read = session?.jobOutput` (App.tsx:1583/1643 before this
    // fix) → the read runs unbound, `this.runs` throws, React unmounts the tree
    // and `TAIL of the job` never reaches the frame.
    const session = new ClassSession();
    session.onJobs = (listener) => {
      listener({
        rows: [{ id: "bg-3", command: "watch grep", startedAt: Date.now(), status: "running" }],
        count: 1,
      });
      return () => {};
    };
    const app = await mount(session);
    // An open session (a prompt went out): the wire id exists, as under `connect`.
    await type(app, "hello");
    // DOWN onto the pill, ENTER into the dropdown, ENTER on the job row.
    app.stdin.write(DOWN);
    await delay(60);
    app.stdin.write(ENTER);
    await delay(80);
    app.stdin.write(ENTER);
    await delay(150);
    expect(session.ran.reads).toBeGreaterThanOrEqual(1);
    expect(strip(app.lastFrame())).toContain("TAIL of the job");
    app.unmount();
  });
});
