import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSessionStore, restartPromptOf } from "@tentacle/agent";
import { loadConfig } from "@tentacle/config";
import {
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
  type PermissionRequest,
  type StreamEvent,
} from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { createChannelPair } from "@tentacle/transport";
import { createLocalRuntime } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";
import { buildAgent } from "../src/wiring.ts";

// docs/feat/context-reset.md (slice 3), end to end: the real `buildAgent`
// (the tool, the loop, the refresh over real files), a real daemon, the
// laptop's `RemoteClient` runtime and its saved copy. A skill and an
// AGENTS.md edit made AFTER the start are in the fresh context; the reset's
// ask reaches the LAPTOP broker (the single one); the daemon's barrier is a
// commit point (F2: what it cut is never popped later).

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-context-reset-e2e-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

class ScriptedProvider implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push({ ...request, messages: [...request.messages] });
    for (const event of this.script[this.turn++] ?? [{ type: "text", delta: "end" }]) {
      yield event;
    }
    yield { type: "done" };
  }
}

const writeSkill = async (root: string, name: string, description: string) => {
  await mkdir(join(root, name), { recursive: true });
  await writeFile(
    join(root, name, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n${name} instructions\n`,
  );
};

test("a context reset end to end: fresh files, the laptop's approval, the saved copy, the cut", async () => {
  const cfgDir = join(dir, "cfg");
  await mkdir(cfgDir, { recursive: true });
  await writeFile(join(cfgDir, "PROMPT.md"), "IDENTITY\n");
  await writeFile(join(dir, "AGENTS.md"), "RULES v1\n");
  await writeSkill(join(dir, ".agents", "skills"), "alpha", "first skill");
  const config = await loadConfig({ env: { HOME: dir }, configDir: cfgDir, cwd: dir });
  // `refreshSessionContext` reads `process.env` (HOME, TENTACLE_SYSTEM_PROMPT).
  const savedHome = process.env.HOME;
  const savedPrompt = process.env.TENTACLE_SYSTEM_PROMPT;
  const promptKey = "TENTACLE_SYSTEM_PROMPT";
  const homeKey = "HOME";
  process.env.HOME = dir;
  delete process.env[promptKey];
  try {
    const model = new ScriptedProvider([
      [
        {
          type: "tool_call",
          toolCall: {
            id: "r1",
            name: "context_reset",
            arguments: JSON.stringify({ prompt: "goal: G. plan: docs/p.md. next: load late" }),
          },
        },
      ],
      [
        {
          type: "tool_call",
          toolCall: { id: "k1", name: "skill", arguments: JSON.stringify({ name: "late" }) },
        },
      ],
      [], // an empty round right after: pushed, then popped (the nudge)
      [{ type: "text", delta: "done on the fresh context" }],
    ]);
    const logged: string[] = [];
    const noticed: string[] = [];
    const host = new SessionHost({
      defaultCwd: dir,
      createAgent: () => {
        const wired = buildAgent(config, {
          modelOverride: model,
          log: (l) => logged.push(l),
          notice: (l) => noticed.push(l),
        });
        return { agent: wired.agent, permissions: wired.permissions, jobs: wired.jobs };
      },
    });
    const [daemonCh, clientCh] = createChannelPair();
    const connection = new Connection(daemonCh, host);
    // The laptop's ONE broker answers the prompt.
    const laptop = new PermissionBroker();
    const asked: PermissionRequest[] = [];
    laptop.setRequester(async (req) => {
      asked.push(req);
      return { allowed: true };
    });
    const store = new JsonSessionStore(join(dir, "sessions"));
    const runtime = await createLocalRuntime({
      channel: clientCh,
      disposeTransport: () => connection.close(),
      permissions: laptop,
      saver: new SessionSaver(store, () => {}),
      cwd: dir,
      model: "scripted",
      resume: null,
    });

    // After the start: a new skill and an edited AGENTS.md.
    await writeSkill(join(dir, ".agents", "skills"), "late", "added after the start");
    await writeFile(join(dir, "AGENTS.md"), "RULES v2\n");
    // A skill with no description: the reset's scan reports it.
    await mkdir(join(dir, ".agents", "skills", "broken"), { recursive: true });
    await writeFile(
      join(dir, ".agents", "skills", "broken", "SKILL.md"),
      "---\nname: broken\n---\nx\n",
    );

    const controller = runtime.createSession();
    const types: string[] = [];
    let cut: { epoch: string | undefined; messages: readonly unknown[] } | undefined;
    for await (const event of controller.send("hello")) {
      types.push(event.type);
      if (event.type === "context_reset" && cut === undefined) {
        // The daemon's view once the client got the reset (same epoch: past the barrier).
        const page = [...host.values()][0]?.snapshotPage();
        if (page) cut = { epoch: page.since?.epoch, messages: page.messages };
      }
    }
    expect(types.at(-1)).toBe("turn_end");
    expect(types).toContain("context_reset");

    // The ask reached the laptop broker, showing the restart prompt.
    expect(asked.map((r) => [r.tool, r.detail])).toEqual([
      ["context_reset", "goal: G. plan: docs/p.md. next: load late"],
    ]);

    // The scan's diagnostic is a notice (not labelled/handled as a hook failure).
    expect(noticed.some((l) => l.startsWith("context reset: ") && l.includes("broken"))).toBe(true);
    expect(logged).toEqual([]);

    // Round 2 ran on the fresh context: re-read AGENTS.md, the new skill in the
    // catalog AND the `skill` enum, and it loaded.
    const fresh = model.requests[1];
    const system = fresh?.messages[0]?.content ?? "";
    expect(system).toContain("RULES v2");
    expect(system).toContain("<name>late</name>");
    const skillTool = fresh?.tools?.find((t) => t.name === "skill");
    expect(
      (skillTool?.parameters as { properties: { name: { enum: string[] } } }).properties.name.enum,
    ).toEqual(["alpha", "late"]);
    expect(restartPromptOf(fresh?.messages[1]?.content ?? "")).toBe(
      "goal: G. plan: docs/p.md. next: load late",
    );
    expect(model.requests[2]?.messages.at(-1)?.content).toContain('<skill_content name="late">');

    // F2 at the daemon: the history the barrier cut is never popped — the
    // final history, same epoch, starts with it.
    const end = [...host.values()][0]?.snapshotPage();
    expect(cut?.epoch).toBeDefined();
    expect(end?.since?.epoch).toBe(cut?.epoch ?? "");
    const tail: unknown[] = end?.messages.slice(0, cut?.messages.length) ?? [];
    expect(tail).toEqual([...(cut?.messages ?? [])]);

    // The laptop's saved copy holds only the fresh context (decision 4).
    await new Promise((r) => setTimeout(r, 20));
    const listed = await store.list();
    const record = listed.records[0];
    expect(record?.messages[0]?.content).toBe(system);
    expect(restartPromptOf(record?.messages[1]?.content ?? "")).toBe(
      "goal: G. plan: docs/p.md. next: load late",
    );
    expect(record?.messages.some((m) => m.content === "hello")).toBe(false);
    expect(record?.messages.at(-1)?.content).toBe("done on the fresh context");
    runtime.dispose();
  } finally {
    if (savedHome === undefined) delete process.env[homeKey];
    else process.env.HOME = savedHome;
    if (savedPrompt !== undefined) process.env.TENTACLE_SYSTEM_PROMPT = savedPrompt;
  }
});
