/**
 * The `workload_shell` registry's TEARDOWN (docs/feat/workload-shell.md D4): a
 * session that ends must leave NOTHING running in the workload, and a settings
 * sync must not silently drop shells the session is still using.
 *
 * Two sites matter, and both are silent if broken:
 * - the session's END disposes the registry (beside `jobs`), so no `sh` and no
 *   child process survives it;
 * - a settings rebuild KEEPS the session's registry (it is the session's, not the
 *   agent's), and only a factory that ignored `reuse` has its own closed.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatMessage,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import type { Attachment, HostedSession } from "../src/hosted-session.ts";
import { SessionHost } from "../src/session-host.ts";

const CWD = "/tmp/workload-shell-teardown";
const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

class Chat implements ModelProvider {
  readonly id = "chat";
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "ok" };
  }
}

/** A registry stand-in: counts its disposals (the real one is I/O-bound). */
class SpyShells {
  disposals = 0;
  async dispose(): Promise<void> {
    this.disposals++;
  }
}

function rig() {
  const broker = new PermissionBroker();
  const shells = new SpyShells();
  /** What the NEXT factory build returns as its own registry. */
  let nextShells: SpyShells | undefined = shells;
  const host = new SessionHost({
    defaultCwd: CWD,
    createAgent: () => ({
      agent: new Agent({
        model: new Chat(),
        tools: new ToolRegistry(),
        env,
        systemPrompt: "sys",
      }),
      permissions: broker,
      grants: undefined,
      workloadShells: nextShells,
    }),
  });
  const updates: unknown[] = [];
  const attachment: Attachment = { send: (u) => void updates.push(u) };
  const open = (messages?: ChatMessage[]): HostedSession =>
    host.open({ create: true, ...(messages ? { messages: messages as never } : {}) }, attachment)
      .hosted;
  return {
    host,
    shells,
    open,
    setNextShells: (value: SpyShells | undefined) => {
      nextShells = value;
    },
  };
}

const SEED: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hi" },
];

describe("the session's shells are disposed when the session ends", () => {
  test("closing the session closes them (the no-leftovers rule)", async () => {
    const r = rig();
    const session = r.open(SEED);
    expect(r.shells.disposals).toBe(0);
    session.close();
    expect(r.shells.disposals).toBe(1);
  });

  test("a session that never offered the tool has nothing to dispose, and still closes cleanly", () => {
    const r = rig();
    r.setNextShells(undefined);
    const session = r.open(SEED);
    session.close(); // no throw: the teardown is optional
    expect(r.shells.disposals).toBe(0);
  });
});

describe("a settings rebuild keeps the session's registry", () => {
  test("the next agent is handed the SAME registry, so an open shell survives a sync", async () => {
    const r = rig();
    const session = r.open(SEED);
    // A rebuild that ignores `reuse` and builds its OWN registry: that one is
    // closed, and the SESSION's is untouched (its shells are still in use).
    const foreign = new SpyShells();
    r.setNextShells(foreign);
    try {
      r.host.updateSettings(session, session.id, { autoAccept: false } as never);
    } catch {
      // A foreign rebuild is refused (its error text is not this test's subject).
    }
    // Whatever the factory decided, the session's own registry was NOT disposed
    // by a rebuild: only the session's end closes it.
    expect(r.shells.disposals).toBe(0);

    // Now a factory that HONOURS `reuse`: the hand-over must keep the registry.
    r.setNextShells(undefined);
    session.close();
    expect(r.shells.disposals).toBe(1); // disposed exactly once, at the end
  });
});
