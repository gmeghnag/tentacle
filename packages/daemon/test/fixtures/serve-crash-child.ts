/**
 * S11's child (docs/feat/session-log-serve-store.md): a `serve`-like daemon on
 * the store at argv[2] — it reloads session "s" the way `serve`'s start-up
 * scan does (no state file → the log set aside; else load + restore), then runs
 * turns forever (a `run` call, then text) until the parent SIGKILLs it. Each
 * `run` appends its unique `n` to `<dir>/runs.log` (sync), so the parent can
 * tell whether any call ever ran twice. Prints `ready` once the reload is done.
 */
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { z } from "zod";
import type { HostedSession } from "../../src/hosted-session.ts";
import { SessionHost } from "../../src/session-host.ts";
import { LogSessionStore } from "../../src/session-log-store.ts";
import { SessionPersister } from "../../src/session-persister.ts";

const dir = process.argv[2] ?? "";
const CWD = "/tmp/serve-crash";
const seed = `${process.pid}-${Date.now()}`;
let calls = 0;

class Loop implements ModelProvider {
  readonly id = "loop";
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    calls++;
    await new Promise((r) => setTimeout(r, 1));
    if (calls % 2 === 1) {
      yield {
        type: "tool_call",
        toolCall: {
          id: `c${seed}-${calls}`,
          name: "run",
          arguments: JSON.stringify({ n: `${seed}-${calls}` }),
        },
      };
    } else {
      yield { type: "text", delta: `answer ${calls}` };
    }
    yield { type: "done" };
  }
}

const store = new LogSessionStore(dir);
const persister = new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} });
const model = new Loop();
const host = new SessionHost({
  defaultCwd: CWD,
  persister,
  createAgent: () => {
    const permissions = new PermissionBroker();
    const tools = new ToolRegistry().register({
      name: "run",
      description: "run",
      inputSchema: z.object({ n: z.string() }),
      permission: "none",
      async execute(input) {
        appendFileSync(join(dir, "runs.log"), `${(input as { n: string }).n}\n`);
        return { content: "ok" };
      },
    });
    const agent = new Agent({ model, tools, env: {} as ExecutionEnvironment });
    return { agent, permissions };
  },
});

let hosted: HostedSession | undefined;
const state = await persister.loadState("s");
if (!state.ok && state.missingState) {
  await store.setAside("s", "a log with no state file");
} else if (state.ok) {
  const loaded = await persister.load("s");
  if (!loaded.ok) throw new Error(loaded.reason);
  hosted = host.restore(loaded.record);
}
hosted ??= host.open({ sessionId: "s", create: true }, { send: () => {} }).hosted;
process.stdout.write("ready\n");
for (let i = 0; ; i++) {
  while (hosted.running) await new Promise((r) => setTimeout(r, 1));
  hosted.prompt(`T${seed}-${i}`, [{ type: "text", text: `prompt ${seed}-${i}` }]);
}
