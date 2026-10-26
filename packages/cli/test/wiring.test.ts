import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AskHooksTrust, type HookRunner, Session } from "@tentacle/agent";
import type { ChatRequest, ModelProvider, StreamEvent, ToolResult } from "@tentacle/core";
import { SessionHost } from "@tentacle/daemon";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { daemonErrorLogPath } from "../src/daemon-log.ts";
import {
  buildAgent,
  inProcessAgents,
  loadUserAgentTypes,
  skillCatalog,
  skillListing,
} from "../src/wiring.ts";

let dir: string;
let config: TentacleConfig;
const saved: Record<string, string | undefined> = {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-wiring-"));
  for (const key of ["TENTACLE_CONFIG_DIR"]) saved[key] = process.env[key];
  process.env.TENTACLE_CONFIG_DIR = join(dir, "config"); // never the user's config
  config = await loadConfig({ cwd: dir });
});

afterAll(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("inProcessAgents (single-broker invariant, AGENTS §7)", () => {
  test("every per-session agent — before and after /clear — asks the ONE broker the TUI prompts on", async () => {
    // Mutation: `build: () => buildAgent(config)` (a broker per agent, which
    // auto-approves by default) → the TUI's requester is never reached.
    const { permissions, build } = inProcessAgents(config);
    const asked: string[] = [];
    permissions.setRequester(async (req) => {
      asked.push(req.title);
      return { allowed: false };
    });
    const first = build();
    const second = build(); // the session after /clear
    expect(first.permissions).toBe(permissions);
    expect(second.permissions).toBe(permissions);
    expect(first.jobs).not.toBe(second.jobs); // one BackgroundJobs per session (D3)
    for (const wired of [first, second]) {
      const answer = await wired.permissions.request({
        tool: "shell",
        level: "ask",
        title: "run ls",
        input: {},
      });
      expect(answer.allowed).toBe(false);
    }
    expect(asked).toEqual(["run ls", "run ls"]);
  });
});

/** A model whose turns are scripted; records every request it receives. */
class ScriptedModel implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  private turn = 0;
  constructor(private readonly script: readonly (readonly StreamEvent[])[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    for (const event of this.script[this.turn++] ?? [{ type: "done" }]) {
      yield event;
    }
  }
}

describe("buildAgent skills (docs/feat/skills-core.md)", () => {
  // ~32 KB like the real hf-cli: over the 16000-char spill threshold, with a
  // run of identical lines the dedup transform would collapse.
  const BODY = `# Big skill\n${"same line\n".repeat(50)}${Array.from({ length: 1100 }, (_, i) => `step ${i}: do the thing carefully\n`).join("")}END-OF-SKILL\n`;

  async function skillConfig(overrides: Partial<TentacleConfig> = {}): Promise<TentacleConfig> {
    const home = join(dir, `home-${Math.random().toString(36).slice(2)}`);
    await mkdir(join(home, ".agents", "skills", "big"), { recursive: true });
    await writeFile(
      join(home, ".agents", "skills", "big", "SKILL.md"),
      `---\nname: big\ndescription: a big skill\n---\n${BODY}`,
    );
    const cfg = await loadConfig({ env: { HOME: home }, configDir: join(home, "cfg"), cwd: home });
    return { ...cfg, subagentsEnabled: false, ...overrides };
  }

  async function activate(cfg: TentacleConfig): Promise<{ content: string; model: ScriptedModel }> {
    const model = new ScriptedModel([
      [
        { type: "tool_call", toolCall: { id: "k1", name: "skill", arguments: '{"name":"big"}' } },
        { type: "done" },
      ],
      [{ type: "text", delta: "ok" }, { type: "done" }],
    ]);
    const { agent } = buildAgent(cfg, { modelOverride: model });
    let content = "";
    for await (const event of agent.run("s", [{ role: "user", content: "go" }])) {
      if (event.type === "tool_result") {
        content = event.result.content;
      }
    }
    return { content, model };
  }

  test("the skill body reaches the model verbatim — never spilled, deduped or summarised", async () => {
    // Mutation (red, verified): drop the `exemptTools` wrapping in wiring.ts →
    // the body comes back as a spill preview and END-OF-SKILL is missing.
    expect(BODY.length).toBeGreaterThan(30_000);
    for (const cfg of [
      await skillConfig(),
      await skillConfig({ summarizeLargeOutput: true, dedupOutput: true }),
    ]) {
      const { content, model } = await activate(cfg);
      expect(content).toStartWith('<skill_content name="big">\n# Big skill\n');
      expect(content).toContain(BODY.trimEnd());
      expect(model.requests.length).toBe(2); // no summarisation call
      const sent = model.requests[1]?.messages.find((m) => m.role === "tool");
      // Verbatim; the only addition is the context line after it (docs/feat/context-awareness.md).
      expect(sent?.content.replace(/\n\n\[context: [^\]]+\]$/, "")).toBe(content);
    }
  });

  test("/compact re-reads an active skill through the real transforms: edited, verbatim, still redacted", async () => {
    // docs/feat/skills-compaction.md: the re-run takes the same path as an
    // activation — exempt from spill/dedup/summary, but not from redaction.
    const cfg = await skillConfig({
      summarizeLargeOutput: true,
      dedupOutput: true,
      redactSecrets: true,
    });
    const location = cfg.skills[0]?.location;
    if (!location) throw new Error("expected the big skill");
    const model = new ScriptedModel([
      [
        { type: "tool_call", toolCall: { id: "k1", name: "skill", arguments: '{"name":"big"}' } },
        { type: "done" },
      ],
      [{ type: "text", delta: "ok" }, { type: "done" }],
      [{ type: "text", delta: "the brief" }, { type: "done" }],
    ]);
    const { agent } = buildAgent(cfg, { modelOverride: model });
    const session = new Session(agent);
    for await (const _ of session.send("go")) {
      // run the activation turn
    }
    const SECRET = "AKIAABCDEFGHIJKLMNOP";
    await writeFile(
      location,
      `---\nname: big\ndescription: a big skill\n---\n${BODY}EDITED with key ${SECRET}\n`,
    );

    await session.compact();

    const round = session.messages.find((m) => m.role === "tool" && m.toolCallId === "k1");
    expect(round?.content).toStartWith('<skill_content name="big">\n# Big skill\n');
    expect(round?.content).toContain(`${BODY}EDITED with key [REDACTED]`);
    expect(round?.content).not.toContain(SECRET);
    expect(model.requests.length).toBe(3); // the turn's two rounds + the summary; no output summarising
    expect(model.requests[2]?.messages[1]?.content).not.toContain("step 500:");
  });

  test("another tool's large output is still spilled (the exemption is per tool)", async () => {
    const cfg = await skillConfig();
    const model = new ScriptedModel([
      [
        {
          type: "tool_call",
          toolCall: {
            id: "r1",
            name: "fs_read",
            arguments: JSON.stringify({ path: cfg.skills[0]?.location }),
          },
        },
        { type: "done" },
      ],
      [{ type: "text", delta: "ok" }, { type: "done" }],
    ]);
    const { agent } = buildAgent({ ...cfg, cwd: dir }, { modelOverride: model });
    let content = "";
    for await (const event of agent.run("s", [{ role: "user", content: "go" }])) {
      if (event.type === "tool_result") {
        content = event.result.content;
      }
    }
    expect(content).toContain("saved to .tentacle/tool-output/fs_read-r1.txt");
    expect(content).not.toContain("step 500:");
  });

  test("the tool is registered only when a skill is offered; the catalog is in the prompt", async () => {
    const cfg = await skillConfig();
    expect(cfg.systemPrompt).toContain("<name>big</name>");
    const names = (c: TentacleConfig) =>
      buildAgent(c)
        .tools.definitions()
        .map((d) => d.name);
    expect(names(cfg)).toContain("skill");
    expect(names({ ...cfg, skills: [] })).not.toContain("skill");
    expect(
      names({ ...cfg, skills: cfg.skills.map((s) => ({ ...s, modelInvocable: false })) }),
    ).not.toContain("skill");
  });

  test("/name: the daemon catalog and what the agent activates for the user are one rule", async () => {
    const cfg = await skillConfig();
    const base = cfg.skills[0];
    if (!base) {
      throw new Error("expected a skill");
    }
    const skills = [
      base,
      { ...base, name: "hidden", modelInvocable: false },
      { ...base, name: "model-only", userInvocable: false },
      { ...base, name: "Bad Name" },
    ];
    const c = { ...cfg, skills };
    const catalog = skillCatalog(c);
    expect(catalog.map((s) => s.name)).toEqual(["big", "hidden"]);
    const { agent, tools } = buildAgent(c);
    for (const name of ["big", "hidden", "model-only", "Bad Name", "nope"]) {
      expect({ name, user: agent.canActivateForUser(name) }).toEqual({
        name,
        user: catalog.some((s) => s.name === name),
      });
    }
    // The model's enum stays the offered list: the hidden skill is not in it.
    const skillDef = tools.definitions().find((d) => d.name === "skill");
    expect(JSON.stringify(skillDef)).not.toContain('"hidden"');
  });

  test("/skills: the listing's user/model flags are the agent's own rules (docs/feat/skills-panel.md)", async () => {
    const cfg = await skillConfig();
    const base = cfg.skills[0];
    if (!base) {
      throw new Error("expected a skill");
    }
    const skills = [
      base,
      { ...base, name: "hidden", modelInvocable: false },
      { ...base, name: "model-only", userInvocable: false, scope: "user" as const },
      { ...base, name: "Bad Name" },
      { ...base, name: "neither", modelInvocable: false, userInvocable: false },
    ];
    const c = {
      ...cfg,
      skills,
      skillDiagnostics: ["skipped skill at /x/SKILL.md: no description"],
    };
    const listing = skillListing(c);
    expect(listing.problems).toEqual(["skipped skill at /x/SKILL.md: no description"]);
    expect(listing.skills.map((s) => [s.name, s.scope, s.location])).toEqual(
      skills.map((s) => [s.name, s.scope, s.location]),
    );
    const { agent, tools } = buildAgent(c);
    const skillDef = JSON.stringify(tools.definitions().find((d) => d.name === "skill"));
    for (const s of listing.skills) {
      expect({ name: s.name, user: s.user, model: s.model }).toEqual({
        name: s.name,
        user: agent.canActivateForUser(s.name),
        model: skillDef.includes(`"${s.name}"`),
      });
    }
    expect(listing.skills.find((s) => s.name === "neither")).toMatchObject({
      user: false,
      model: false,
    });
  });

  test("/name end-to-end: a user-activated hidden skill's body reaches the model's first round", async () => {
    const cfg = await skillConfig();
    const base = cfg.skills[0];
    if (!base) {
      throw new Error("expected a skill");
    }
    const model = new ScriptedModel([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const { agent } = buildAgent(
      { ...cfg, cwd: dir, skills: [{ ...base, modelInvocable: false }] },
      { modelOverride: model },
    );
    const session = new Session(agent, "s");
    for await (const _ of session.send("/big now", undefined, { skill: "big" })) {
      // drain
    }
    // One model round, and the round's result precedes the reply (the request
    // holds the live history, so look at the order, not the tail).
    expect(model.requests).toHaveLength(1);
    const roles = session.messages.map((m) => m.role);
    expect(roles.slice(1)).toEqual(["user", "assistant", "tool", "assistant"]);
    expect(session.messages[3]?.content).toStartWith('<skill_content name="big">\n# Big skill\n');
  });
});

describe("large output is the LAST transform (docs/feat/tui-spill-note.md)", () => {
  test("spill.head is cut from the redacted, deduplicated text, and content is exactly its banner + parts", async () => {
    // Mutation (red, verified): move `shaping(largeOutput)` before the dedup
    // transform in wiring.ts → content and spill diverge.
    const SECRET = "AKIAABCDEFGHIJKLMNOP";
    const command = `echo ${SECRET}; for i in 1 2 3 4 5; do echo same; done; seq 1 20000`;
    const model = new ScriptedModel([
      [
        {
          type: "tool_call",
          toolCall: { id: "o1", name: "shell", arguments: JSON.stringify({ command }) },
        },
        { type: "done" },
      ],
      [{ type: "text", delta: "ok" }, { type: "done" }],
    ]);
    const { agent } = buildAgent(
      { ...config, redactSecrets: true, dedupOutput: true, tabulateJson: true },
      { modelOverride: model },
    );
    let result: ToolResult | undefined;
    for await (const event of agent.run("s", [{ role: "user", content: "go" }])) {
      if (event.type === "tool_result") result = event.result;
    }
    const spill = result?.spill;
    expect(spill).toBeDefined();
    if (!result || !spill) return;
    expect(spill.head).toContain("[REDACTED]");
    expect(spill.head).not.toContain(SECRET);
    expect(spill.head).toContain("repeated 4 more times");
    expect(result.content).toBe(
      `[large shell output: full output (${spill.chars} chars) saved to ${spill.path} — read it selectively with fs_read (offset/limit) or grep; do NOT read it whole]\n${spill.head}\n…[${spill.omitted} characters omitted]…\n${spill.tail}`,
    );
  });
});

describe("hooks wiring (docs/feat/hooks-core.md)", () => {
  test("real hook processes: tool_call deny in the gate; tool_result after redaction, replacing the result", async () => {
    const seen = join(dir, "hook-seen.json");
    const SECRET = "AKIAABCDEFGHIJKLMNOP";
    const model = new ScriptedModel([
      [
        {
          type: "tool_call",
          toolCall: { id: "h1", name: "shell", arguments: JSON.stringify({ command: "rm -rf x" }) },
        },
        {
          type: "tool_call",
          toolCall: {
            id: "h2",
            name: "shell",
            arguments: JSON.stringify({ command: `echo ${SECRET}` }),
          },
        },
        { type: "done" },
      ],
      [{ type: "text", delta: "ok" }, { type: "done" }],
    ]);
    const { agent } = buildAgent(
      {
        ...config,
        redactSecrets: true,
        hooks: [
          {
            event: "tool_call",
            matcher: "shell",
            name: "no-rm",
            command: `grep -q 'rm -rf' && { echo "no rm here" >&2; exit 2; }; exit 0`,
          },
          {
            event: "tool_result",
            matcher: "shell",
            command: `cat > '${seen}'; printf '{"content":"replaced"}'`,
          },
        ],
      },
      { modelOverride: model },
    );
    const results: { content: string; hook?: unknown }[] = [];
    for await (const event of agent.run("s", [{ role: "user", content: "go" }])) {
      if (event.type === "tool_result") results.push(event.result);
    }
    expect(results[0]?.hook).toEqual({ action: "blocked", name: "no-rm", reason: "no rm here" });
    // The blocked call's refusal text also went through the tool_result hook.
    expect(results.map((r) => r.content)).toEqual(["replaced", "replaced"]);
    const input = JSON.parse(await readFile(seen, "utf8"));
    expect(input.tool_call_id).toBe("h2");
    expect(input.tool_result.content).toContain("[REDACTED]");
    expect(input.tool_result.content).not.toContain(SECRET);
  });

  test("turn_start runs as a real process; model_request does not run over a model tunnel (D2)", async () => {
    const mr = join(dir, "model-request-ran");
    const model = new ScriptedModel([[{ type: "text", delta: "ok" }, { type: "done" }]]);
    const { agent } = buildAgent(
      {
        ...config,
        hooks: [
          { event: "turn_start", command: `printf '{"context":"from hook"}'` },
          { event: "model_request", command: `touch '${mr}'` },
        ],
      },
      { modelOverride: model },
    );
    const notes: string[] = [];
    for await (const event of agent.run("s", [{ role: "user", content: "go" }])) {
      if (event.type === "context_note") notes.push(event.text);
    }
    await new Promise((r) => setTimeout(r, 200));
    expect(notes).toEqual(["[hook turn_start] from hook"]);
    expect(await Bun.file(mr).exists()).toBe(false);
  });
});

describe("project hooks wiring (docs/feat/hooks-project-trust.md)", () => {
  const projectHooks = {
    folder: "/repo",
    hash: "h1",
    hooks: [{ event: "turn_start" as const, command: "./a.sh" }],
    files: [".agents/hooks.json"],
  };
  /** The agent's private config, read for the wiring only. */
  const agentConfig = (wired: ReturnType<typeof buildAgent>) =>
    (
      wired.agent as unknown as {
        config: { hooks?: HookRunner; askHooksTrust?: AskHooksTrust };
      }
    ).config;
  const unusedModel: ModelProvider = {
    id: "unused",
    // biome-ignore lint/correctness/useYield: never called
    async *stream() {
      throw new Error("unused");
    },
  };

  test("a project hook may allow locally, never over the pod model tunnel (D6)", () => {
    const local = agentConfig(buildAgent({ ...config, projectHooks }));
    expect(local.hooks?.projectTrustRequest()?.canAllow).toBe(true);
    const pod = agentConfig(
      buildAgent({ ...config, projectHooks }, { modelOverride: unusedModel }),
    );
    expect(pod.hooks?.projectTrustRequest()?.canAllow).toBe(false);
  });

  test("in-process: hooks the wire schema rejects are declined, never asked, and logged (fix/in-process-hooks-trust-schema)", async () => {
    const overLimit = {
      ...projectHooks,
      hooks: [{ event: "turn_start" as const, command: `echo ${"x".repeat(5000)}` }],
    };
    const { permissions, build } = inProcessAgents({ ...config, projectHooks: overLimit });
    let asked = 0;
    permissions.setRequester(async () => {
      asked++;
      return { allowed: true, scope: "once" };
    });
    const { hooks, askHooksTrust } = agentConfig(build());
    expect(hooks).toBeDefined();
    if (hooks) {
      await hooks.resolveProjectTrust("s1", askHooksTrust);
      expect(hooks.hasAny("turn_start")).toBe(false);
      expect(hooks.needsProjectTrust()).toBe(false); // declined for the session
    }
    expect(asked).toBe(0);
    const log = await readFile(daemonErrorLogPath(config.configDir), "utf8").catch(() => "");
    expect(log).toContain("hooks.0.command");
  });

  test("in-process: the trust question goes to the ONE broker the TUI prompts on", async () => {
    const { permissions, build } = inProcessAgents({ ...config, projectHooks });
    const kinds: (string | undefined)[] = [];
    permissions.setRequester(async (req) => {
      kinds.push(req.kind);
      return { allowed: true, scope: "once" };
    });
    const ask = agentConfig(build()).askHooksTrust;
    const request = agentConfig(build()).hooks?.projectTrustRequest();
    expect(ask).toBeDefined();
    expect(request).toBeDefined();
    if (ask && request) {
      expect(await ask({ ...request, sessionId: "s1" })).toBe(true);
    }
    expect(kinds).toEqual(["hooks_trust"]);
  });
});

describe("loadUserAgentTypes with package dirs (docs/feat/packages.md)", () => {
  test("package agent types are offered; a clash keeps <configDir>/agents' and names both", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-types-"));
    const cfg = join(root, "cfg");
    const pkgA = join(cfg, "packages", "a", "agents");
    const pkgB = join(cfg, "packages", "b", "agents");
    for (const d of [join(cfg, "agents"), pkgA, pkgB]) await mkdir(d, { recursive: true });
    await writeFile(join(cfg, "agents", "scout.md"), "---\ndescription: mine\n---\nmine");
    await writeFile(join(pkgA, "scout.md"), "---\ndescription: from a\n---\na");
    await writeFile(join(pkgA, "linter.md"), "---\ndescription: a linter\n---\nlint");
    // Same type name via frontmatter, different file: the first package wins.
    await writeFile(join(pkgB, "other.md"), "---\nname: linter\ndescription: b\n---\nb");
    const { types, diagnostics } = loadUserAgentTypes(cfg, [pkgA, pkgB]);
    expect(types.map((t) => [t.name, t.description])).toEqual([
      ["scout", "mine"],
      ["linter", "a linter"],
    ]);
    expect(diagnostics).toEqual([
      `agent type "scout" in ${join(pkgA, "scout.md")} ignored (already defined by ${join(cfg, "agents", "scout.md")})`,
      `agent type "linter" in ${join(pkgB, "other.md")} ignored (already defined by ${join(pkgA, "linter.md")})`,
    ]);
  });
});

describe("loadUserAgentTypes: built-in shadowing (post-review)", () => {
  test("a package type replacing a built-in is reported; the user's own is not", async () => {
    const root = await mkdtemp(join(tmpdir(), "agent-builtin-"));
    const cfg = join(root, "cfg");
    const pkg = join(root, "pkg", "agents");
    for (const d of [join(cfg, "agents"), pkg]) await mkdir(d, { recursive: true });
    await writeFile(join(cfg, "agents", "explore.md"), "mine");
    await writeFile(join(pkg, "general-purpose.md"), "theirs");
    const { diagnostics } = loadUserAgentTypes(cfg, [pkg]);
    expect(diagnostics).toEqual([
      `agent type "general-purpose" in ${join(pkg, "general-purpose.md")} replaces the built-in one`,
    ]);
  });
});

describe("hook env dirs wiring (docs/feat/hook-env-dirs.md)", () => {
  const runnerOpts = (wired: ReturnType<typeof buildAgent>) =>
    (
      wired.agent as unknown as {
        config: { hooks?: { opts: { projectDir?: string; cwd: string } } };
      }
    ).config.hooks?.opts;

  test("buildAgent always hands the runner config.projectDir", () => {
    const user = {
      ...config,
      cwd: "/repo/sub",
      projectDir: "/repo",
      hooks: [{ event: "turn_start" as const, command: "u" }],
    };
    expect(runnerOpts(buildAgent(user))?.projectDir).toBe("/repo");
  });
});

describe("session titles: which model names a session (docs/feat/session-titles.md)", () => {
  const titleModelOf = (wired: object): ModelProvider | undefined =>
    (wired as { titleModel?: ModelProvider }).titleModel;

  // `config` is loaded in `beforeAll`: read it lazily.
  const on = (): TentacleConfig => ({ ...config, autoTitle: true });

  test("over the pod model tunnel the override answers (the laptop's model; no creds in the pod)", () => {
    const tunnel: ModelProvider = { id: "tunnel", stream: () => (async function* () {})() };
    const wired = buildAgent({ ...on(), titleModel: "small" }, { modelOverride: tunnel });
    expect(titleModelOf(wired)).toBe(tunnel);
    // The pod's title tunnel (purpose "title") wins over the turn's one.
    const titled: ModelProvider = { id: "titled", stream: () => (async function* () {})() };
    const both = buildAgent(on(), { modelOverride: tunnel, titleModelOverride: titled } as never);
    expect(titleModelOf(both)).toBe(titled);
  });

  test("locally: model.titleModel on the same endpoint, else the main model", () => {
    const small = titleModelOf(buildAgent({ ...on(), titleModel: "small" }));
    expect(small?.id).toBe(`${config.provider}:small`);
    expect(titleModelOf(buildAgent(on()))?.id).toBe(`${config.provider}:${config.model}`);
  });

  test("model.autoTitle off (the default): NO title model at all, whatever else is set", () => {
    expect(config.autoTitle).toBe(false);
    const tunnel: ModelProvider = { id: "tunnel", stream: () => (async function* () {})() };
    expect(titleModelOf(buildAgent(config))).toBeUndefined();
    expect(titleModelOf(buildAgent({ ...config, titleModel: "small" }))).toBeUndefined();
    expect(titleModelOf(buildAgent(config, { modelOverride: tunnel }))).toBeUndefined();
    expect(
      titleModelOf(
        buildAgent(config, { modelOverride: tunnel, titleModelOverride: tunnel } as never),
      ),
    ).toBeUndefined();
  });

  test("end to end: off → a spy model sees ZERO title calls (the turn only); on → one", async () => {
    const run = async (autoTitle: boolean): Promise<ChatRequest[]> => {
      const seen: ChatRequest[] = [];
      const spy: ModelProvider = {
        id: "spy",
        async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
          seen.push(request);
          await new Promise((r) => setTimeout(r, 1));
          yield { type: "text", delta: "Spy reply" };
          yield { type: "done" };
        },
      };
      const host = new SessionHost({
        defaultCwd: dir,
        createAgent: (cwd) => buildAgent({ ...config, cwd, autoTitle }, { modelOverride: spy }),
      });
      const { hosted } = host.open({ sessionId: "s", create: true }, { send: () => {} });
      hosted.prompt("t1", [{ type: "text", text: "please fix the login bug" }]);
      while (hosted.running) await new Promise((r) => setTimeout(r, 2));
      await new Promise((r) => setTimeout(r, 30));
      host.get("s")?.close();
      return seen;
    };
    const isTitle = (r: ChatRequest) => r.messages[0]?.content.includes("3–6 word title") === true;
    const off = await run(false);
    expect(off).toHaveLength(1);
    expect(off.filter(isTitle)).toEqual([]);
    const enabled = await run(true);
    expect(enabled.filter(isTitle)).toHaveLength(1);
  });
});

describe("project dir without project hooks (post-review)", () => {
  test("git repo, no .agents/hooks.json, launched from src/api → hooks see the repo root", async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "proj-dir-")));
    const repo = join(root, "repo");
    const sub = join(repo, "src", "api");
    await mkdir(join(repo, ".git"), { recursive: true });
    await mkdir(sub, { recursive: true });
    const cfgDir = join(root, "cfg");
    await mkdir(cfgDir);
    await writeFile(
      join(cfgDir, "config.jsonc"),
      '{ "hooks": [{ "event": "turn_end", "command": "u" }] }',
    );
    const cfg = await loadConfig({ env: { HOME: root }, configDir: cfgDir, cwd: sub });
    const wired = buildAgent(cfg);
    const opts = (
      wired.agent as unknown as { config: { hooks?: { opts: { projectDir?: string } } } }
    ).config.hooks?.opts;
    expect(opts?.projectDir).toBe(repo);
  });
});

// docs/feat/context-awareness.md: `contextAwareness` + `model.contextWindow` reach the
// main agent AND each sub-agent; disabled → no line anywhere.
describe("buildAgent context awareness", () => {
  async function turn(cfg: TentacleConfig): Promise<ScriptedModel> {
    const model = new ScriptedModel([
      [
        {
          type: "tool_call",
          toolCall: {
            id: "t1",
            name: "agent_task",
            arguments: JSON.stringify({ description: "look", prompt: "sub task" }),
          },
        },
        { type: "done" },
      ],
      [{ type: "text", delta: "child report" }, { type: "done" }],
      [{ type: "text", delta: "ok" }, { type: "done" }],
    ]);
    const { agent } = buildAgent(cfg, { modelOverride: model });
    for await (const _ of agent.run("s", [{ role: "user", content: "go" }])) {
      // drain
    }
    return model;
  }
  const LINE = / \/ 200k tokens \(\d+%\)\]$/;

  test("enabled: the main prompt and the sub-agent prompt carry the line, on the configured window", async () => {
    const model = await turn({ ...config, subagentsEnabled: true, contextWindow: 200000 });
    expect(model.requests.length).toBe(3);
    expect(model.requests[0]?.messages.at(-1)?.content).toMatch(LINE);
    // The child's own first request: its task prompt.
    expect(model.requests[1]?.messages.at(-1)?.content).toMatch(/^sub task\n\n\[context: /);
    expect(model.requests[1]?.messages.at(-1)?.content).toMatch(LINE);
  });

  test("disabled: no line in any request", async () => {
    const model = await turn({
      ...config,
      subagentsEnabled: true,
      contextWindow: 200000,
      contextAwareness: { enabled: false, stepPercent: 1 },
    });
    for (const r of model.requests) {
      expect(r.messages.some((m) => m.content.includes("[context: "))).toBe(false);
    }
  });
});
