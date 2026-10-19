import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import type { ChatRequest, ExecutionEnvironment, ModelProvider } from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Round 1 streams, then pauses so a task can be queued into the running turn. */
class SlowProvider implements ModelProvider {
  readonly id = "slow";
  turn = 0;
  async *stream(_req: ChatRequest) {
    this.turn++;
    if (this.turn === 1) {
      yield { type: "text", delta: "first" } as const;
      await delay(150);
      yield { type: "done" } as const;
    } else {
      yield { type: "text", delta: `second(${this.turn})` } as const;
      yield { type: "done" } as const;
    }
  }
}

describe("mid-turn task queue (steering)", () => {
  test("a task typed while running is shown queued, then injected and run", async () => {
    const model = new SlowProvider();
    const agent = new Agent({ model, tools: new ToolRegistry(), env: noopEnv });
    const { stdin, frames, lastFrame, unmount } = render(
      <App agent={agent} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("go");
    await delay(20);
    stdin.write("\r");
    await delay(50); // turn 1 is running (mid pause)

    stdin.write("also do X");
    await delay(20);
    stdin.write("\r");
    await delay(40);

    // The queued task is visible with its pending marker while the turn runs.
    expect(lastFrame() ?? "").toContain("⏳ also do X");

    await delay(300); // let the turn end, steer, and run the injected round
    const all = frames.join("\n");
    // It entered the conversation as a user turn and the model ran again.
    expect(all).toContain("also do X");
    expect(model.turn).toBeGreaterThanOrEqual(2);
    unmount();
  });
});

describe("mid-turn steering reconciliation (RPC delivery failure)", () => {
  /**
   * A remote-like session whose `send` keeps the turn running (a tool in
   * flight) and whose `enqueue` resolves/rejects like a daemon would, so the
   * App's mid-turn steering branch (optimistic ⏳ + reconciliation) is driven
   * without a real daemon.
   */
  function makeController(enqueueImpl: (text: string) => void | Promise<void>) {
    return {
      async *send() {
        yield { type: "tool_start", id: "c1", name: "shell", arguments: "" } as const;
        await delay(5000); // hold the turn open so state.running stays true
        yield { type: "turn_end", reason: "end_turn" } as const;
      },
      enqueue: enqueueImpl,
    };
  }

  test("an enqueue that REJECTS removes the optimistic ⏳ row and warns", async () => {
    let enqueued = 0;
    const { stdin, lastFrame, unmount } = render(
      <App
        createSession={() =>
          makeController((text) => {
            enqueued += 1;
            void text;
            // Reject after a beat so the optimistic ⏳ renders first, then the
            // reconciliation removes it (the observable we assert).
            return new Promise<void>((_resolve, reject) => {
              setTimeout(() => reject(new Error("method not found")), 80);
            });
          })
        }
        model="qwen3"
        cwd="/tmp/work"
      />,
    );
    await delay(30);
    stdin.write("go");
    await delay(20);
    stdin.write("\r");
    await delay(80); // turn 1 running (tool in flight)
    stdin.write("steer me");
    await delay(20);
    stdin.write("\r");
    await delay(20); // optimistic ⏳ is up; the reject (80 ms) has not fired yet

    // Optimistic: the queued task shows while delivery is pending.
    expect(lastFrame() ?? "").toContain("⏳ steer me");
    expect(enqueued).toBe(1);

    // Delivery rejects → the optimistic row is reconciled away and a warning
    // surfaces (otherwise it would mask a send that never happened).
    await delay(140);
    const after = lastFrame() ?? "";
    expect(after).not.toContain("⏳ steer me");
    expect(after).toContain("not queued");
    // The notice carries the actual cause, not a guess ("old daemon").
    expect(after).toContain("method not found");
    unmount();
  });

  test("an enqueue that RESOLVES keeps the ⏳ row until a steer echo / turn_end", async () => {
    const { stdin, lastFrame, unmount } = render(
      <App
        createSession={() => makeController(() => Promise.resolve())}
        model="qwen3"
        cwd="/tmp/work"
      />,
    );
    await delay(30);
    stdin.write("go");
    await delay(20);
    stdin.write("\r");
    await delay(80);
    stdin.write("steer me");
    await delay(20);
    stdin.write("\r");
    await delay(140); // enqueue resolved, but no steer echo and no turn_end yet

    // Resolving does NOT clear the row: it waits for the `steer` echo (or the
    // turn_end clear) — matching local semantics, so a resolved-but-not-injected
    // task is still visible, not silently dropped.
    expect(lastFrame() ?? "").toContain("⏳ steer me");
    unmount();
  });
});
