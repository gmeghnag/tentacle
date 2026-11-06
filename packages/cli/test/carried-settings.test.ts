/**
 * The laptop carries its settings into a pod (docs/feat/config-carry.md): one
 * table classifies every key, P (the laptop decides) or W (the laptop's value is
 * the lowest layer), and the overlay is pure.
 */
import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { JsonSessionStore } from "@tentacle/agent";
import { refreshSessionContext } from "@tentacle/config";
import { PermissionBroker } from "@tentacle/core";
import {
  Method,
  PROTOCOL_VERSION,
  type SessionSettings,
  type SessionSettingsReport,
} from "@tentacle/protocol";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import {
  CARRIED,
  applyCarried,
  carriedSettings,
  createSettingsNotifier,
  settingsNotices,
} from "../src/carried-settings.ts";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { createLocalRuntime } from "../src/local-runtime.ts";
import { SessionSaver } from "../src/session-saver.ts";

const made: string[] = [];
function dir(files: Record<string, string> = {}): string {
  const d = mkdtempSync(join(tmpdir(), "carried-"));
  made.push(d);
  for (const [name, text] of Object.entries(files)) {
    const path = join(d, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return d;
}
afterAll(() => {
  for (const d of made) {
    rmSync(d, { recursive: true, force: true });
  }
});

type Env = Record<string, string>;

function pod(file: unknown = {}, env: Env = {}, cwd: string = dir()): Promise<TentacleConfig> {
  return loadConfig({
    configDir: dir({ "config.jsonc": JSON.stringify(file) }),
    cwd,
    scaffold: false,
    env: { HOME: dir(), ...env },
    podDaemon: true,
  });
}

const UNSET = await pod();

// One row per W key: the pod's explicit file and env forms, both set to the value
// an unset pod has, and a carried value that differs from it.
const W: readonly {
  readonly key: keyof SessionSettings;
  readonly file: (podValue: never) => unknown;
  readonly env?: (podValue: never) => Env;
  readonly carried: unknown;
}[] = [
  {
    key: "loadAgentsMd",
    file: (v) => ({ loadAgentsMd: v }),
    env: () => ({ TENTACLE_NO_AGENTS_MD: "0" }),
    carried: false,
  },
  {
    key: "loadSkills",
    file: (v) => ({ loadSkills: v }),
    env: () => ({ TENTACLE_NO_SKILLS: "0" }),
    carried: false,
  },
  {
    key: "maxIterations",
    file: (v) => ({ maxIterations: v }),
    env: (v) => ({ TENTACLE_MAX_ITERATIONS: String(v) }),
    carried: 99,
  },
  {
    key: "contextAwarenessEnabled",
    file: (v) => ({ contextAwareness: { enabled: v } }),
    carried: false,
  },
  {
    key: "contextAwarenessStepPercent",
    file: (v) => ({ contextAwareness: { stepPercent: v } }),
    carried: 50,
  },
  {
    key: "contextResetEnabled",
    file: (v) => ({ contextReset: { enabled: v } }),
    env: () => ({ TENTACLE_CONTEXT_RESET: "1" }),
    carried: false,
  },
  {
    key: "contextResetMaxPerMessage",
    file: (v) => ({ contextReset: { maxPerMessage: v } }),
    env: (v) => ({ TENTACLE_CONTEXT_RESET_MAX: String(v) }),
    carried: 3,
  },
  {
    key: "maxInlineOutputChars",
    file: (v) => ({ tools: { maxInlineOutputChars: v } }),
    env: (v) => ({ TENTACLE_MAX_OUTPUT_CHARS: String(v) }),
    carried: 1234,
  },
  {
    key: "redactSecrets",
    file: (v) => ({ tools: { redactSecrets: v } }),
    env: (v) => ({ TENTACLE_REDACT_SECRETS: v ? "1" : "0" }),
    carried: !UNSET.redactSecrets,
  },
  {
    key: "dedupOutput",
    file: (v) => ({ tools: { dedupOutput: v } }),
    env: (v) => ({ TENTACLE_DEDUP_OUTPUT: v ? "1" : "0" }),
    carried: !UNSET.dedupOutput,
  },
  {
    key: "tabulateJson",
    file: (v) => ({ tools: { tabulateJson: v } }),
    env: (v) => ({ TENTACLE_TABULATE_JSON: v ? "1" : "0" }),
    carried: !UNSET.tabulateJson,
  },
  {
    key: "summarizeLargeOutput",
    file: (v) => ({ tools: { summarizeLargeOutput: v } }),
    env: (v) => ({ TENTACLE_SUMMARIZE_OUTPUT: v ? "1" : "0" }),
    carried: !UNSET.summarizeLargeOutput,
  },
  {
    key: "toolExecution",
    file: (v) => ({ tools: { execution: v } }),
    env: (v) => ({ TENTACLE_TOOL_EXECUTION: String(v) }),
    carried: "parallel",
  },
  {
    key: "toolMaxParallel",
    file: (v) => ({ tools: { maxParallel: v } }),
    env: (v) => ({ TENTACLE_TOOL_MAX_PARALLEL: String(v) }),
    carried: 3,
  },
];

// One row per P key: a pod that sets it, by file and by env, to another value.
const P: readonly {
  readonly key: keyof SessionSettings;
  readonly file: unknown;
  readonly env?: Env;
  readonly carried: unknown;
}[] = [
  {
    key: "contextWindow",
    file: { model: { contextWindow: 111 } },
    env: { TENTACLE_CONTEXT_WINDOW: "111" },
    carried: 200000,
  },
  { key: "autoTitle", file: { model: { autoTitle: true } }, carried: false },
  {
    key: "subagentsEnabled",
    file: { subagents: { enabled: false } },
    env: { TENTACLE_SUBAGENTS: "0" },
    carried: true,
  },
  {
    key: "subagentMaxIterations",
    file: { subagents: { maxIterations: 7 } },
    env: { TENTACLE_SUBAGENT_MAX_ITERATIONS: "7" },
    carried: 42,
  },
  {
    key: "subagentExecution",
    file: { subagents: { execution: "sequential" } },
    env: { TENTACLE_SUBAGENT_EXECUTION: "sequential" },
    carried: "read-only",
  },
  {
    key: "subagentMaxParallel",
    file: { subagents: { maxParallel: 9 } },
    env: { TENTACLE_SUBAGENT_MAX_PARALLEL: "9" },
    carried: 2,
  },
  {
    key: "agentTaskDescription",
    file: { subagents: { agentTaskDescription: "the pod's text" } },
    carried: "the laptop's text",
  },
];

const ALL_KEYS = [
  "agentTaskDescription",
  "autoTitle",
  "contextAwarenessEnabled",
  "contextAwarenessStepPercent",
  "contextResetEnabled",
  "contextResetMaxPerMessage",
  "contextWindow",
  "dedupOutput",
  "loadAgentsMd",
  "loadSkills",
  "maxInlineOutputChars",
  "maxIterations",
  "redactSecrets",
  "subagentExecution",
  "subagentMaxIterations",
  "subagentMaxParallel",
  "subagentsEnabled",
  "summarizeLargeOutput",
  "tabulateJson",
  "toolExecution",
  "toolMaxParallel",
] as const;

const read = (key: keyof SessionSettings, config: TentacleConfig): unknown =>
  CARRIED[key].read(config);

describe("the table is complete", () => {
  test("7 P + 14 W, and the two test tables cover each", () => {
    expect(Object.keys(CARRIED).sort()).toEqual([...ALL_KEYS]);
    const classOf = (name: "P" | "W") =>
      Object.entries(CARRIED)
        .filter(([, row]) => row.class === name)
        .map(([key]) => key)
        .sort();
    expect(classOf("P")).toEqual(P.map((row) => row.key).sort());
    expect(classOf("W")).toEqual(W.map((row) => row.key).sort());
  });

  test("autoWake is not carried: only the laptop's TUI reads it", () => {
    expect(Object.hasOwn(CARRIED, "autoWake")).toBe(false);
  });
});

describe("carriedSettings: an allowlist", () => {
  test("exactly the 21 keys, and no secret or code, whatever the config holds", async () => {
    const laptop = await loadConfig({
      configDir: dir({
        "config.jsonc": JSON.stringify({
          model: { apiKey: "sk-secret-value", baseURL: "http://secret.example/v1" },
          hooks: [{ event: "tool_call", command: "echo SECRET-HOOK" }],
          mcpServers: { secretserver: { command: "secret-mcp" } },
          subagents: { agentTaskDescription: "custom" },
        }),
      }),
      cwd: dir({ "AGENTS.md": "SECRET-RULES\n" }),
      scaffold: false,
      env: { HOME: dir() },
    });
    const carried = carriedSettings(laptop);
    expect(Object.keys(carried).sort()).toEqual([...ALL_KEYS]);
    const json = JSON.stringify(carried);
    for (const secret of [
      "sk-secret-value",
      "secret.example",
      "SECRET-HOOK",
      "secretserver",
      "SECRET-RULES",
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  test("the laptop's resolved values: env > active profile > global", async () => {
    const configDir = dir({
      "config.jsonc": JSON.stringify({
        maxIterations: 5,
        tools: { maxParallel: 5 },
        profiles: { p: { tools: { maxParallel: 6 }, subagents: { maxParallel: 6 } } },
      }),
    });
    const laptop = await loadConfig({
      configDir,
      cwd: dir(),
      scaffold: false,
      profile: "p",
      env: { HOME: dir(), TENTACLE_SUBAGENT_MAX_PARALLEL: "7" },
    });
    const carried = carriedSettings(laptop);
    expect(carried.maxIterations).toBe(5);
    expect(carried.toolMaxParallel).toBe(6);
    expect(carried.subagentMaxParallel).toBe(7);
  });

  test("no custom description: the key is absent, not undefined on the wire", () => {
    const carried = carriedSettings(UNSET);
    expect(Object.hasOwn(carried, "agentTaskDescription")).toBe(false);
    expect(Object.keys(carried)).toHaveLength(20);
  });
});

describe("W: the laptop's value is the lowest layer", () => {
  for (const row of W) {
    test(`${row.key}: an unset pod takes it, stamped carried`, async () => {
      const { config, report } = applyCarried(UNSET, { [row.key]: row.carried });
      expect(read(row.key, config)).toBe(row.carried);
      const source = CARRIED[row.key].source;
      expect(config.sources[source]).toBe("carried");
      expect(report?.overridden).toEqual({});
    });

    test(`${row.key}: a pod's FILE wins, even set to the default value`, async () => {
      const podValue = read(row.key, UNSET);
      const explicit = await pod(row.file(podValue as never));
      const { config, report } = applyCarried(explicit, { [row.key]: row.carried });
      expect(read(row.key, config)).toBe(podValue);
      expect(config.sources[CARRIED[row.key].source]).toBe("file");
      expect(report?.overridden).toEqual({ [row.key]: podValue });
    });

    if (row.env) {
      const envOf = row.env;
      test(`${row.key}: a pod's ENV wins, even set to the default value`, async () => {
        const podValue = read(row.key, UNSET);
        const explicit = await pod({}, envOf(podValue as never));
        const { config, report } = applyCarried(explicit, { [row.key]: row.carried });
        expect(read(row.key, config)).toBe(podValue);
        expect(config.sources[CARRIED[row.key].source]).toBe("env");
        expect(report?.overridden).toEqual({ [row.key]: podValue });
      });
    }
  }

  test("a pod that sets the SAME value overrides nothing worth saying", async () => {
    const explicit = await pod({ maxIterations: 40 });
    const { report } = applyCarried(explicit, { maxIterations: 40 });
    expect(report?.overridden).toEqual({});
  });

  test("containerKeys: every carried W key the pod sets, whatever its value (docs/feat/session-settings-apply.md)", async () => {
    // Mutation: list only the overridden ones → maxIterations (same value) is missing.
    const explicit = await pod({ maxIterations: 40, tools: { dedupOutput: false } });
    const { report } = applyCarried(explicit, { maxIterations: 40, dedupOutput: true });
    expect(report?.containerKeys).toEqual(["maxIterations", "dedupOutput"]);
    expect(applyCarried(UNSET, { maxIterations: 40 }).report?.containerKeys).toBeUndefined();
    // A key the laptop did not carry is not reported.
    expect(applyCarried(explicit, {}).report?.containerKeys).toBeUndefined();
  });

  test("a key the laptop did not send: the pod's value stands", () => {
    const { config } = applyCarried(UNSET, {});
    expect(config.maxIterations).toBe(UNSET.maxIterations);
    expect(config.sources.maxIterations).toBe("default");
  });
});

describe("P: the laptop decides", () => {
  for (const row of P) {
    test(`${row.key}: beats a pod's file`, async () => {
      const set = await pod(row.file);
      const { config, report, pinnedOver } = applyCarried(set, { [row.key]: row.carried });
      expect(read(row.key, config)).toBe(row.carried);
      expect(report?.overridden).toEqual({});
      expect(pinnedOver).toEqual([row.key]);
    });

    if (row.env) {
      const env = row.env;
      test(`${row.key}: beats a pod's env`, async () => {
        const set = await pod({}, env);
        const { config, pinnedOver } = applyCarried(set, { [row.key]: row.carried });
        expect(read(row.key, config)).toBe(row.carried);
        expect(pinnedOver).toEqual([row.key]);
      });
    }

    test(`${row.key}: an unset pod has nothing pinned over`, () => {
      const { config, pinnedOver } = applyCarried(UNSET, { [row.key]: row.carried });
      expect(read(row.key, config)).toBe(row.carried);
      expect(pinnedOver).toEqual([]);
    });
  }

  test("the description: settings present, key absent → the neutral default, never the pod's text", async () => {
    const set = await pod({ subagents: { agentTaskDescription: "the pod's text" } });
    const { config, pinnedOver } = applyCarried(set, { maxIterations: 3 });
    expect(config.agentTaskDescription).toBeUndefined();
    expect(pinnedOver).toEqual(["agentTaskDescription"]);
  });

  test("autoTitle: settings present, key absent → off, whatever the pod says", async () => {
    const set = await pod({ model: { autoTitle: true } });
    expect(applyCarried(set, {}).config.autoTitle).toBe(false);
  });
});

describe("a bare open (no settings): the pod's own values", () => {
  test("titles stay off; everything else, the description too, is the pod's", async () => {
    const set = await pod({
      model: { autoTitle: true, contextWindow: 111 },
      subagents: { agentTaskDescription: "the pod's text" },
      maxIterations: 8,
    });
    const { config, report, pinnedOver } = applyCarried(set, undefined);
    expect(config.autoTitle).toBe(false);
    expect(config.contextWindow).toBe(111);
    expect(config.maxIterations).toBe(8);
    expect(config.agentTaskDescription).toBe("the pod's text");
    expect(report).toBeUndefined();
    expect(pinnedOver).toEqual([]);
  });
});

describe("loadAgentsMd / loadSkills are recomposed, not just flipped", () => {
  const repo = () =>
    dir({
      "AGENTS.md": "RULE-FROM-AGENTS-MD\n",
      ".git/HEAD": "ref\n",
      ".agents/skills/demo/SKILL.md": "---\nname: demo\ndescription: a demo skill\n---\nBody\n",
    });

  test("the start has both", async () => {
    const start = await pod({}, {}, repo());
    expect(start.systemPrompt).toContain("RULE-FROM-AGENTS-MD");
    expect(start.systemPrompt).toContain("demo");
    expect(start.skills).toHaveLength(1);
  });

  test("carried false over an unset pod: gone from the prompt and the skill list", async () => {
    const start = await pod({}, {}, repo());
    const noAgents = applyCarried(start, { loadAgentsMd: false }).config;
    expect(noAgents.systemPrompt).not.toContain("RULE-FROM-AGENTS-MD");
    expect(noAgents.systemPrompt).toContain("demo");
    expect(noAgents.agentsPath).toBeUndefined();

    const noSkills = applyCarried(start, { loadSkills: false }).config;
    expect(noSkills.systemPrompt).toContain("RULE-FROM-AGENTS-MD");
    expect(noSkills.systemPrompt).not.toContain("demo");
    expect(noSkills.skills).toEqual([]);
    expect(noSkills.skillDiagnostics).toEqual([]);
  });

  test("a context reset afterwards agrees with the merged flags", async () => {
    const start = await pod({}, {}, repo());
    const merged = applyCarried(start, { loadAgentsMd: false, loadSkills: false }).config;
    const fresh = await refreshSessionContext(merged, { HOME: dir() });
    expect(fresh.systemPrompt).toBe(merged.systemPrompt);
    expect(fresh.skills).toEqual([]);
  });

  test("nothing carried off: the prompt is byte-identical", async () => {
    const start = await pod({}, {}, repo());
    const same = applyCarried(start, carriedSettings(start)).config;
    expect(same.systemPrompt).toBe(start.systemPrompt);
    expect(same.skills).toEqual(start.skills);
  });

  test("the pod's own loadAgentsMd: true beats a carried false, and keeps the rules", async () => {
    const start = await pod({ loadAgentsMd: true }, {}, repo());
    const merged = applyCarried(start, { loadAgentsMd: false }).config;
    expect(merged.systemPrompt).toContain("RULE-FROM-AGENTS-MD");
  });
});

describe("createLocalRuntime: the report reaches the user through `notify`", () => {
  async function rig(sessionSettings: SessionSettings | undefined, report: unknown) {
    const [daemonCh, clientCh] = createChannelPair();
    const opens: unknown[] = [];
    const daemon = new RpcPeer(daemonCh, {
      onRequest: (method, params) => {
        const p = params as { sessionId?: string; turnId?: string };
        if (method === Method.Open) {
          opens.push(params);
          return {
            sessionId: p.sessionId ?? "s1",
            epoch: "e",
            created: true,
            resync: false,
            settings: report,
          };
        }
        if (method === Method.Prompt) {
          return { turnId: p.turnId }; // the turn never ends: only the session matters
        }
        return {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: { tools: true, permissions: true },
        };
      },
    });
    const notices: string[] = [];
    const runtime = await createLocalRuntime({
      channel: clientCh,
      disposeTransport: () => daemon.close(),
      permissions: new PermissionBroker(),
      saver: new SessionSaver(new JsonSessionStore(dir()), () => {}),
      cwd: "/tmp/work",
      model: "m",
      resume: null,
      notify: (text) => notices.push(text),
      ...(sessionSettings ? { sessionSettings } : {}),
    });
    const iterator = runtime.createSession().send("hi")[Symbol.asyncIterator]();
    void iterator.next().catch(() => {});
    const start = Date.now();
    while (opens.length === 0 && Date.now() - start < 2000) {
      await new Promise((r) => setTimeout(r, 5));
    }
    await new Promise((r) => setTimeout(r, 10));
    runtime.dispose();
    return { opens, notices };
  }

  test("a pod's override: one line through notify, and the open carried the settings", async () => {
    const mine: SessionSettings = { maxIterations: 9 };
    const stdout = spyOn(process.stdout, "write");
    const { opens, notices } = await rig(mine, {
      carried: mine,
      overridden: { dedupOutput: true },
    });
    const raw = stdout.mock.calls.length;
    stdout.mockRestore();
    expect((opens[0] as { settings?: unknown }).settings).toEqual(mine);
    expect(notices).toEqual(['Container config: { "tools.dedupOutput": true }']);
    expect(raw).toBe(0);
  });

  test("no option (the worker): nothing on the wire, and a report is not listened to", async () => {
    // Mutation: set `sessionSettings` at the worker's `createLocalRuntime` call: this
    // pins the seam, not that call (see the task doc's Execution).
    const { opens, notices } = await rig(undefined, {
      carried: {},
      overridden: { dedupOutput: true },
    });
    expect((opens[0] as { settings?: unknown }).settings).toBeUndefined();
    expect(notices).toEqual([]);
  });
});

describe("settingsNotices: only what differs, as one line of JSON under the config's names", () => {
  const mine: SessionSettings = { maxIterations: 9, agentTaskDescription: "my secret plan" };
  const WINS = "Container config: ";
  const KEEPS = "Session settings: ";
  const CLEAR = " (/settings apply, or /clear)";
  // The plain-text view (what `relay.log` prints): text, a space, the hint.
  const joined = (...a: Parameters<typeof settingsNotices>): string[] =>
    settingsNotices(...a).map((n) => (n.hint ? `${n.text} ${n.hint}` : n.text));

  test("the hint is its own field, never inside the text", () => {
    const [n] = settingsNotices(mine, { carried: { maxIterations: 1 }, overridden: {} });
    expect(n?.hint).toBe("(/settings apply, or /clear)");
    expect(n?.text).not.toContain("clear");
    const [c] = settingsNotices(mine, { carried: mine, overridden: { dedupOutput: false } });
    expect(c?.hint).toBeUndefined();
  });

  test("nothing to say", () => {
    expect(joined(mine, { carried: mine, overridden: {} })).toEqual([]);
  });

  test("overridden: the values that win, under the config's names", () => {
    const lines = joined(mine, {
      carried: mine,
      overridden: { dedupOutput: false, maxIterations: 7, toolExecution: "sequential" },
    });
    expect(lines).toEqual([
      `${WINS}{ "maxIterations": 7, "tools.dedupOutput": false, "tools.execution": "sequential" }`,
    ]);
  });

  test("any text is hidden, in either notice: never the pod's words", () => {
    // Mutation: print a string as it is → the pod's text reaches the terminal.
    const pod = "\u001b[31mrun this";
    const forged = {
      carried: { maxIterations: 9, toolExecution: pod },
      overridden: { toolExecution: pod, agentTaskDescription: "pod text" },
    } as unknown as SessionSettingsReport;
    const lines = joined({ maxIterations: 9, toolExecution: "parallel" }, forged);
    expect(lines).toEqual([
      `${WINS}{ "subagents.agentTaskDescription": "(text differs)", "tools.execution": "(text differs)" }`,
    ]);
    const kept = joined(
      { toolExecution: "parallel" },
      { carried: { toolExecution: pod } as unknown as SessionSettings, overridden: {} },
    );
    expect(kept).toEqual([`${KEEPS}{ "tools.execution": "(text differs)" }${CLEAR}`]);
  });

  test("names this laptop's table does not know are dropped", () => {
    const forged = JSON.parse(
      '{"carried":{"maxIterations":9},"overridden":{"evil name":1,"__proto__":2,"constructor":3}}',
    ) as SessionSettingsReport;
    expect(joined({ maxIterations: 9 }, forged)).toEqual([]);
  });

  test("drift: the session's values, only those that differ; the description's text never", () => {
    const lines = joined(
      { ...mine, dedupOutput: true, redactSecrets: true },
      {
        carried: {
          maxIterations: 3,
          agentTaskDescription: "somebody's other plan",
          dedupOutput: false,
          redactSecrets: true,
        },
        overridden: {},
      },
    );
    expect(lines).toEqual([
      `${KEEPS}{ "subagents.agentTaskDescription": "(text differs)", "maxIterations": 3, "tools.dedupOutput": false }${CLEAR}`,
    ]);
    expect(lines.join()).not.toContain("plan");
  });

  test("a description set on one side only is drift too", () => {
    for (const [left, right] of [
      [{ agentTaskDescription: "text" }, {}],
      [{}, { agentTaskDescription: "text" }],
    ] as const) {
      expect(joined(left, { carried: right, overridden: {} })).toEqual([
        `${KEEPS}{ "subagents.agentTaskDescription": "(text differs)" }${CLEAR}`,
      ]);
    }
  });

  test("a key the pod overrode is told once, with the value that wins", () => {
    // Mutation: leave it in the drift → the session seems to keep 3, while 7 runs.
    const lines = joined(
      { maxIterations: 5 },
      { carried: { maxIterations: 3 }, overridden: { maxIterations: 7 } },
    );
    expect(lines).toEqual([`${WINS}{ "maxIterations": 7 }`]);
  });

  test("a pod value equal to this laptop's is not told: only what differs", () => {
    // Mutation: list every overridden key → "maxIterations": 9 appears though it is 9 here.
    const same = { carried: { maxIterations: 3, dedupOutput: true }, overridden: {} };
    expect(
      joined(
        { maxIterations: 9, dedupOutput: false },
        { ...same, overridden: { maxIterations: 9, dedupOutput: true } },
      ),
    ).toEqual([`${WINS}{ "tools.dedupOutput": true }`]);
    expect(
      joined(
        { maxIterations: 9 },
        { carried: { maxIterations: 3 }, overridden: { maxIterations: 9 } },
      ),
    ).toEqual([]);
  });

  test("a value the session's report leaves out has nothing to show", () => {
    expect(joined({ maxIterations: 5 }, { carried: {}, overridden: {} })).toEqual([]);
  });

  test("once per session and text: a reconnect's re-open repeats nothing", () => {
    const said: string[] = [];
    const notify = createSettingsNotifier(mine, (text) => said.push(text));
    const report = { carried: mine, overridden: { dedupOutput: false } };
    notify({ sessionId: "a", report });
    notify({ sessionId: "a", report });
    expect(said).toHaveLength(1);
    notify({ sessionId: "b", report });
    expect(said).toHaveLength(2);
    notify({ sessionId: "a", report: { carried: { maxIterations: 1 }, overridden: {} } });
    expect(said).toHaveLength(3);
    expect(said[2]).toContain("Session settings:");
  });

  test("forget(session): after an apply, the same drift is news again (that session only)", () => {
    // Mutation: forget nothing → the second "a" notice is swallowed.
    const said: string[] = [];
    const notify = createSettingsNotifier(mine, (text) => said.push(text));
    const report = { carried: { maxIterations: 1 }, overridden: {} };
    notify({ sessionId: "a", report });
    notify({ sessionId: "b", report });
    notify.forget("a");
    notify({ sessionId: "a", report });
    notify({ sessionId: "b", report });
    expect(said).toHaveLength(3);
  });
});
