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
