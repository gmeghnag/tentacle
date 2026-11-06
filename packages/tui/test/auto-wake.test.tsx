import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import type {
  BackgroundJob,
  ChatRequest,
  ExecutionEnvironment,
  JobController,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { render } from "ink-testing-library";
import { App, type SessionController } from "../src/App.tsx";
import { SendNowErrorCode } from "../src/send-now.ts";
import type { SessionActivity } from "../src/turn-feed.ts";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Replies with a fixed line each turn, and counts how many turns ran. */
class ReactProvider implements ModelProvider {
  readonly id = "react";
  turns = 0;
  async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
    this.turns++;
    yield { type: "text", delta: "reacted to the job" };
    yield { type: "done" };
  }
}

/** Holds its first turn until released; the others reply at once. */
class HeldProvider implements ModelProvider {
  readonly id = "held";
  turns = 0;
  private open: () => void = () => {};
  private readonly gate = new Promise<void>((resolve) => {
    this.open = resolve;
  });
  release(): void {
    this.open();
  }
  async *stream(_req: ChatRequest): AsyncIterable<StreamEvent> {
    this.turns++;
    if (this.turns === 1) {
      await this.gate;
    }
    yield { type: "text", delta: "reply" };
    yield { type: "done" };
  }
}

/** An adopted turn, as `watch` raises it: it ends at once. */
const foreignTurn = (): SessionActivity => ({
  kind: "turn",
  turnId: "adopted",
  cancel: () => {},
  events: (async function* () {
    yield { type: "turn_end", reason: "end_turn" } as const;
  })(),
});

/** A JobController whose exits are fired manually. */
class FakeJobs implements JobController {
  private readonly listeners = new Set<(job: BackgroundJob) => void>();
  start(): BackgroundJob {
    throw new Error("unused");
  }
  read(): undefined {
    return undefined;
  }
  kill(): boolean {
    return false;
  }
  list(): readonly BackgroundJob[] {
    return [];
  }
  dispose(): void {}
  onExit(listener: (job: BackgroundJob) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  fire(job: BackgroundJob): void {
    for (const listener of this.listeners) {
      listener(job);
    }
  }
}

const exited: BackgroundJob = {
  id: "j1",
  command: "npm run build",
  startedAt: 0,
  status: "exited",
  exitCode: 0,
};

describe("autonomous wake on job-exit", () => {
  test("a job exit while idle starts a continuation turn (default on)", async () => {
    const model = new ReactProvider();
    const jobs = new FakeJobs();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, jobs });
    const { lastFrame, unmount } = render(
      <App agent={agent} jobs={jobs} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30); // let the jobs subscription attach
    jobs.fire(exited);
    await delay(60); // notice + the continuation turn

    const frame = lastFrame() ?? "";
    expect(frame).toContain("background job j1"); // the exit notice
    expect(frame).toContain("reacted to the job"); // the agent woke and replied
    expect(model.turns).toBe(1);
    unmount();
  });

  test("with auto-wake off, the exit only shows a notice — no turn starts", async () => {
    const model = new ReactProvider();
    const jobs = new FakeJobs();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, jobs });
    const { lastFrame, unmount } = render(
      <App agent={agent} jobs={jobs} model="qwen3" cwd="/tmp/work" autoWakeOnJobExit={false} />,
    );
    await delay(30);
    jobs.fire(exited);
    await delay(60);

    const frame = lastFrame() ?? "";
    expect(frame).toContain("background job j1"); // notice still shows
    expect(frame).not.toContain("reacted to the job"); // but no autonomous turn
    expect(model.turns).toBe(0);
    unmount();
  });

  // Characterisation: green BEFORE the App moved to `@tentacle/core`'s module.
  test("T-TUI-1 an exit during a running turn: exactly one continuation after it", async () => {
    const jobs = new FakeJobs();
    const model = new HeldProvider();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, jobs });
    const { stdin, unmount } = render(<App agent={agent} jobs={jobs} model="q" cwd="/tmp/work" />);
    await delay(30);
    stdin.write("go");
    await delay(10);
    stdin.write("\r");
    await delay(30);
    expect(model.turns).toBe(1);
    jobs.fire(exited);
    await delay(30);
    expect(model.turns).toBe(1); // no second turn while one runs
    model.release();
    await delay(60);
    expect(model.turns).toBe(2);
    await delay(30);
    expect(model.turns).toBe(2);
    unmount();
  });

  test("T-TUI-2 two exits while idle: one turn each at most, never a double for one", async () => {
    const jobs = new FakeJobs();
    const model = new ReactProvider();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, jobs });
    const { unmount } = render(<App agent={agent} jobs={jobs} model="q" cwd="/tmp/work" />);
    await delay(30);
    jobs.fire(exited);
    jobs.fire({ ...exited, id: "j2" }); // the first's wake is running: this one waits for its end
    await delay(80);
    expect(model.turns).toBe(2);
    await delay(30);
    expect(model.turns).toBe(2);
    unmount();
  });

  test("T-TUI-3 a wake handed over by the relay: one continuation at mount", async () => {
    const jobs = new FakeJobs();
    const model = new ReactProvider();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, jobs });
    const { lastFrame, unmount } = render(
      <App agent={agent} jobs={jobs} model="q" cwd="/tmp/work" wakePending />,
    );
    await delay(60);
    expect(model.turns).toBe(1);
    expect(lastFrame() ?? "").toContain("reacted to the job");
    await delay(30);
    expect(model.turns).toBe(1);
    unmount();
  });

  test("T-TUI-3b the same with this TUI's `autoWake` off: none", async () => {
    const jobs = new FakeJobs();
    const model = new ReactProvider();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv, jobs });
    const { unmount } = render(
      <App
        agent={agent}
        jobs={jobs}
        model="q"
        cwd="/tmp/work"
        wakePending
        autoWakeOnJobExit={false}
      />,
    );
    await delay(60);
    expect(model.turns).toBe(0);
    unmount();
  });

  test("T-TUI-4 a handed-over wake that loses the slot (the adopted turn not seen yet) is retried at its end", async () => {
    // Mutation: drop the `refused` step in the lost-slot branch → the wake is silently gone.
    let sends = 0;
    let turns = 0;
    let raise: (activity: SessionActivity) => void = () => {};
    const session = {
      async *send() {
        sends += 1;
        if (sends === 1) {
          // The daemon holds the adopted turn; its activity arrives with the refusal.
          raise(foreignTurn());
          throw Object.assign(new Error("a turn is already running"), {
            code: SendNowErrorCode.TurnInProgress,
          });
        }
        turns += 1;
        yield { type: "turn_end", reason: "end_turn" } as const;
      },
      watch(listener: (activity: SessionActivity) => void) {
        raise = listener;
        return () => {};
      },
      snapshot: () => ({ messages: [] }),
    } as unknown as SessionController;
    const { unmount } = render(
      <App createSession={() => session} model="q" cwd="/tmp/work" wakeHanded />,
    );
    await delay(100);
    expect(sends).toBe(2);
    expect(turns).toBe(1);
    unmount();
  });

  test("T-TUI-5 a count-seeded wake (wakePending alone) that loses the slot is NOT retried: another TUI serves it", async () => {
    // docs/fix/attach-unflushed-exits.md R1. Mutation: seed `handedWakeRef` from `wakePending` too → sends === 2.
    let sends = 0;
    let raise: (activity: SessionActivity) => void = () => {};
    const session = {
      async *send() {
        sends += 1;
        raise(foreignTurn());
        yield* [] as never[];
        throw Object.assign(new Error("a turn is already running"), {
          code: SendNowErrorCode.TurnInProgress,
        });
      },
      watch(listener: (activity: SessionActivity) => void) {
        raise = listener;
        return () => {};
      },
      snapshot: () => ({ messages: [] }),
    } as unknown as SessionController;
    const { unmount } = render(
      <App createSession={() => session} model="q" cwd="/tmp/work" wakePending />,
    );
    await delay(100);
    expect(sends).toBe(1);
    unmount();
  });
});
