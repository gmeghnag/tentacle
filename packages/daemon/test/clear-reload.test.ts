import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import {
  AgentJobs,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { ToolRegistry } from "@tentacle/tools";
import { SessionHost } from "../src/session-host.ts";
import { LogSessionStore } from "../src/session-log-store.ts";
import { SessionPersister } from "../src/session-persister.ts";

// docs/feat/clear-keeps-jobs.md, review M4 / FM 8 (§7 Persistence): a `serve`
// daemon that is stopped after a `/clear` reloads the CLEARED chat (not the old
// one), continues the log from the new segment, and tells the model the child
// that died with the process is lost.
// Mutation: drop `this.persist()` in `HostedSession.clear` → the reload shows the
// old chat (the sidecar is never rewritten after the clear).

const CWD = "/tmp/clear-reload";
const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};
class Quiet implements ModelProvider {
  readonly id = "q";
  async *stream(_r: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

async function findFile(root: string, name: string): Promise<string | null> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      const found = await findFile(path, name);
      if (found) return found;
    } else if (entry.name === name) {
      return path;
    }
  }
  return null;
}

describe("FM 8: the `serve` restart after a /clear (real LogSessionStore)", () => {
  test("the reload is the cleared chat; the log's last segment is the clear's; the child becomes the lost note", async () => {
    const dir = await mkdtemp(join(tmpdir(), "clear-reload-"));
    try {
      const rig = () => {
        const store = new LogSessionStore(dir);
        const persister = new SessionPersister({ store, cwd: CWD, model: "m", onError: () => {} });
        const runtimes: AgentJobs[] = [];
        const host = new SessionHost({
          defaultCwd: CWD,
          persister,
          createAgent: () => {
            const agentJobs = new AgentJobs(2);
            runtimes.push(agentJobs);
            return {
              agent: new Agent({
                model: new Quiet(),
                tools: new ToolRegistry(),
                env,
                agentJobs,
                systemPrompt: "sys",
              }),
              permissions: new PermissionBroker(),
              agentJobs,
            };
          },
        });
        return { host, persister, runtimes };
      };

      const first = rig();
      const { hosted } = first.host.open(
        {
          create: true,
          messages: [
            { role: "system", content: "sys" },
            { role: "user", content: "the OLD chat" },
            { role: "assistant", content: "old reply" },
          ],
        },
        { send: () => {} },
      );
      const gate = Promise.withResolvers<never>();
      const started = first.runtimes[0]?.start(
        { callId: "c1", agentType: "general", description: "map the repo" },
        () => gate.promise,
      );
      expect(started).toEqual({ ok: true, agentId: "sa-1" });
      await hosted.persisted();

      expect(hosted.clear()).toEqual({ before: 3, after: 2 });
      await hosted.persisted();
      await first.persister.stop(); // the "crash": the child dies with the process
      const id = hosted.id;

      // The log on disk: its LAST segment is the clear's (`base.reason: compact`),
      // followed by the re-emitted `subagent_background`; the old chat is not in it.
      const file = await findFile(dir, `${id}.jsonl`);
      expect(file).not.toBeNull();
      const lines = (await readFile(file ?? "", "utf8"))
        .split("\n")
        .filter((l) => l.trim() !== "")
        .map((l) => JSON.parse(l) as { type?: string; reason?: string; content?: string });
      const lastBase = lines.map((l) => l.type).lastIndexOf("base");
      expect(lastBase).toBeGreaterThan(0);
      expect(lines[lastBase]?.reason).toBe("compact");
      const tail = lines.slice(lastBase).map((l) => l.type);
      expect(tail).toContain("subagent_background");
      expect(JSON.stringify(lines.slice(lastBase))).not.toContain("the OLD chat");

      // The reload (a new host on the same store).
      const second = rig();
      const loaded = await second.persister.load(id);
      if (!loaded.ok) throw new Error(loaded.reason);
      expect(loaded.record.paired).toBe(true); // the sidecar's entry is in that segment
      expect(loaded.record.messages.map((m) => `${m.role}:${m.note?.kind ?? ""}`)).toEqual([
        "system:",
        "user:still_running",
      ]);
      expect(JSON.stringify(loaded.record.messages)).not.toContain("the OLD chat");
      expect(loaded.record.loadNotes.map((m) => `${m.note?.kind}:${m.note?.id}`)).toEqual([
        "subagent_lost:sa-1",
      ]);
      const restored = second.host.restore(loaded.record);
      const messages = restored.snapshotPage().messages;
      expect(messages.at(-1)?.note).toEqual({ kind: "subagent_lost", id: "sa-1" });
      expect(JSON.stringify(messages)).not.toContain("the OLD chat");
      await second.persister.stop();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
