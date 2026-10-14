import { describe, expect, test } from "bun:test";
import { Agent } from "@agent-harness/agent";
import {
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
} from "@agent-harness/core";
import type { ChatRequest } from "@agent-harness/core";
import { ToolRegistry, shellTool } from "@agent-harness/tools";
import { render } from "ink-testing-library";
import { App } from "../src/App.tsx";

const noopEnv: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "hi", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Shift+Tab as a terminal sends the back-tab sequence; Ink maps it to tab+shift.
const SHIFT_TAB = "\x1b[Z";

/** Calls the `shell` tool (permission "ask") on round 1, then replies on round 2. */
class ToolThenReplyProvider implements ModelProvider {
  readonly id = "tool-then-reply";
  turn = 0;
  async *stream(_req: ChatRequest) {
    this.turn++;
    if (this.turn === 1) {
      yield {
        type: "tool_call",
        toolCall: { id: "t1", name: "shell", arguments: '{"command":"echo hi"}' },
      } as const;
      yield { type: "done" } as const;
    } else {
      yield { type: "text", delta: "all done" } as const;
      yield { type: "done" } as const;
    }
  }
}

function buildApp() {
  const model = new ToolThenReplyProvider();
  const permissions = new PermissionBroker();
  const tools = new ToolRegistry().register(shellTool);
  const agent = new Agent({
    model,
    tools,
    env: noopEnv,
    requestPermission: (req) => permissions.request(req),
  });
  return { model, permissions, agent };
}

describe("auto-accept mode (Shift+Tab)", () => {
  test("without auto-accept, an ask tool shows a permission prompt", async () => {
    const { permissions, agent } = buildApp();
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} permissions={permissions} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write("go");
    await delay(10);
    stdin.write("\r");
    await delay(60);

    // The turn is parked on the permission dialog (its options are visible).
    expect(lastFrame() ?? "").toContain("No");
    // The status bar always shows the mode; here it is the OFF hint, which also
    // advertises the keybind so it is discoverable.
    expect(lastFrame() ?? "").toContain("auto-accept off (shift+tab)");
    unmount();
  });

  test("Shift+Tab enables auto-accept: the tool runs with no prompt", async () => {
    const { model, permissions, agent } = buildApp();
    const { stdin, frames, lastFrame, unmount } = render(
      <App agent={agent} permissions={permissions} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write(SHIFT_TAB); // turn auto-accept on
    await delay(20);
    expect(lastFrame() ?? "").toContain("auto-accept on");

    stdin.write("go");
    await delay(10);
    stdin.write("\r");
    await delay(120); // round 1 (tool, auto-approved) + round 2 (reply)

    const all = frames.join("\n");
    // No permission dialog was shown, and the whole turn completed.
    expect(all).not.toContain("don't ask again");
    expect(model.turn).toBeGreaterThanOrEqual(2);
    expect(lastFrame() ?? "").toContain("all done");
    unmount();
  });

  test("Shift+Tab twice returns to asking", async () => {
    const { permissions, agent } = buildApp();
    const { stdin, lastFrame, unmount } = render(
      <App agent={agent} permissions={permissions} model="qwen3" cwd="/tmp/work" />,
    );
    await delay(30);
    stdin.write(SHIFT_TAB);
    await delay(20);
    expect(lastFrame() ?? "").toContain("auto-accept on");
    stdin.write(SHIFT_TAB);
    await delay(20);
    expect(lastFrame() ?? "").toContain("auto-accept off");
    unmount();
  });
});
