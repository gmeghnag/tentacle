/**
 * The task-7 `subagents.*` keys (docs/feat/config-carry.md, Q4 = B), the new
 * provenance a pod needs, and the `podDaemon` load.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { KEY_DOCS } from "../src/key-docs.ts";
import { ConfigError, loadConfig } from "../src/load.ts";
import { FileConfigSchema } from "../src/schema.ts";

const made: string[] = [];
function dir(): string {
  const d = mkdtempSync(join(tmpdir(), "subagent-keys-"));
  made.push(d);
  return d;
}
afterAll(() => {
  for (const d of made) {
    rmSync(d, { recursive: true, force: true });
  }
});

async function load(
  config: unknown,
  options: { env?: Record<string, string>; files?: Record<string, string>; profile?: string } = {},
) {
  const configDir = dir();
  writeFileSync(join(configDir, "config.jsonc"), JSON.stringify(config));
  for (const [name, text] of Object.entries(options.files ?? {})) {
    writeFileSync(join(configDir, name), text);
  }
  return loadConfig({
    configDir,
    cwd: dir(),
    scaffold: false,
    env: options.env ?? {},
    ...(options.profile !== undefined ? { profile: options.profile } : {}),
  });
}

describe("subagents.execution / maxParallel", () => {
  test("defaults: parallel, 4", async () => {
    const c = await load({});
    expect(c.subagentExecution).toBe("parallel");
    expect(c.subagentMaxParallel).toBe(4);
    expect(c.sources.subagentExecution).toBe("default");
    expect(c.sources.subagentMaxParallel).toBe("default");
  });

  test("the file sets them; the env wins; a bad env falls through", async () => {
    const file = { subagents: { execution: "read-only", maxParallel: 2 } };
    const fromFile = await load(file);
    expect(fromFile.subagentExecution).toBe("read-only");
    expect(fromFile.subagentMaxParallel).toBe(2);
    expect(fromFile.sources.subagentExecution).toBe("file");
    expect(fromFile.sources.subagentMaxParallel).toBe("file");

    const fromEnv = await load(file, {
      env: { TENTACLE_SUBAGENT_EXECUTION: "sequential", TENTACLE_SUBAGENT_MAX_PARALLEL: "9" },
    });
    expect(fromEnv.subagentExecution).toBe("sequential");
    expect(fromEnv.subagentMaxParallel).toBe(9);
    expect(fromEnv.sources.subagentExecution).toBe("env");

    const bad = await load(file, {
      env: { TENTACLE_SUBAGENT_EXECUTION: "wild", TENTACLE_SUBAGENT_MAX_PARALLEL: "0" },
    });
    expect(bad.subagentExecution).toBe("read-only");
    expect(bad.subagentMaxParallel).toBe(2);
  });

  test("bad values in the file are refused", () => {
    for (const subagents of [{ execution: "wild" }, { maxParallel: 0 }, { maxParallel: 1.5 }]) {
      expect(FileConfigSchema.safeParse({ subagents }).success).toBe(false);
    }
  });
});

describe("subagents.twoWay (T12, docs/feat/agent-message-two-way.md)", () => {
  test("defaults to false, and the source says so", async () => {
    const c = await load({});
    expect(c.subagentsTwoWay).toBe(false);
    expect(c.sources.subagentsTwoWay).toBe("default");
  });

  test("the file sets it; the env wins; a bad env falls through", async () => {
    const file = { subagents: { twoWay: true } };
    const fromFile = await load(file);
    expect(fromFile.subagentsTwoWay).toBe(true);
    expect(fromFile.sources.subagentsTwoWay).toBe("file");

    const fromEnv = await load(file, { env: { TENTACLE_SUBAGENTS_TWO_WAY: "false" } });
    expect(fromEnv.subagentsTwoWay).toBe(false);
    expect(fromEnv.sources.subagentsTwoWay).toBe("env");

    const bad = await load(file, { env: { TENTACLE_SUBAGENTS_TWO_WAY: "maybe" } });
    expect(bad.subagentsTwoWay).toBe(true);
  });

  test("a non-boolean in the file is refused", () => {
    expect(FileConfigSchema.safeParse({ subagents: { twoWay: "yes" } }).success).toBe(false);
  });

  test("a key-docs entry exists and resolves to the config's value", async () => {
    const c = await load({ subagents: { twoWay: true } });
    const doc = KEY_DOCS["subagents.twoWay"];
    expect(doc).toBeDefined();
    expect(doc?.carried).toBe("pinned");
    expect(doc?.env).toBe("TENTACLE_SUBAGENTS_TWO_WAY");
    expect(doc?.sample).toBe("on");
    // The `resolved` accessor is checked against a real resolution by
    // key-docs.test.ts T2 (`emptyResolve`); here the resolved FIELD is pinned.
    expect(c.subagentsTwoWay).toBe(true);
    expect(doc?.default?.()).toBe(false);
  });
});

describe("subagents.agentTaskDescription(File)", () => {
  test("neither: no text", async () => {
    const c = await load({});
    expect(c.agentTaskDescription).toBeUndefined();
    expect(c.sources.agentTaskDescription).toBe("default");
  });

  test("inline: trimmed", async () => {
    const c = await load({ subagents: { agentTaskDescription: "  Delegate.\n" } });
    expect(c.agentTaskDescription).toBe("Delegate.");
    expect(c.sources.agentTaskDescription).toBe("file");
  });

  test("a file relative to the config dir, read and trimmed", async () => {
    const c = await load(
      { subagents: { agentTaskDescriptionFile: "agent-task.md" } },
      { files: { "agent-task.md": "\nFrom a file.\n\n" } },
    );
    expect(c.agentTaskDescription).toBe("From a file.");
  });

  test("an absolute file", async () => {
    const elsewhere = join(dir(), "text.md");
    writeFileSync(elsewhere, "Absolute.");
    const c = await load({ subagents: { agentTaskDescriptionFile: elsewhere } });
    expect(c.agentTaskDescription).toBe("Absolute.");
  });

  test("both in one layer: refused, in the file and in a profile", () => {
    const both = { agentTaskDescription: "a", agentTaskDescriptionFile: "b" };
    const inFile = FileConfigSchema.safeParse({ subagents: both });
    expect(inFile.success).toBe(false);
    expect(inFile.error?.issues[0]?.message).toContain(
      "set agentTaskDescription or agentTaskDescriptionFile, not both",
    );
    expect(FileConfigSchema.safeParse({ profiles: { p: { subagents: both } } }).success).toBe(
      false,
    );
  });

  test("across layers the profile wins, not an error, both ways", async () => {
    const fileOverInline = await load(
      {
        subagents: { agentTaskDescription: "global" },
        profiles: { p: { subagents: { agentTaskDescriptionFile: "p.md" } } },
      },
      { files: { "p.md": "from the profile's file" }, profile: "p" },
    );
    expect(fileOverInline.agentTaskDescription).toBe("from the profile's file");

    const inlineOverFile = await load(
      {
        subagents: { agentTaskDescriptionFile: "missing.md" },
        profiles: { p: { subagents: { agentTaskDescription: "from the profile" } } },
      },
      { profile: "p" },
    );
    expect(inlineOverFile.agentTaskDescription).toBe("from the profile");
  });

  test("a profile that sets neither keeps the global one", async () => {
    const c = await load(
      {
        subagents: { agentTaskDescription: "global" },
        profiles: { p: { subagents: { maxParallel: 2 } } },
      },
      { profile: "p" },
    );
    expect(c.agentTaskDescription).toBe("global");
    expect(c.subagentMaxParallel).toBe(2);
  });

  test("a missing or an empty file is a ConfigError naming the setting and the path", async () => {
    const missing = load({ subagents: { agentTaskDescriptionFile: "nope.md" } });
    await expect(missing).rejects.toBeInstanceOf(ConfigError);
    await expect(missing).rejects.toThrow(/agentTaskDescriptionFile.*nope\.md/);
    const empty = load(
      { subagents: { agentTaskDescriptionFile: "blank.md" } },
      { files: { "blank.md": " \n\n" } },
    );
    await expect(empty).rejects.toThrow(/agentTaskDescriptionFile.*blank\.md.*empty/);
  });

  test("a blank inline text is a ConfigError", async () => {
    await expect(load({ subagents: { agentTaskDescription: "  \n" } })).rejects.toThrow(
      /agentTaskDescription.*empty/,
    );
  });

  test("the cap is 4096 BYTES after trimming, inline and from a file", async () => {
    const atCap = "é".repeat(2048);
    expect((await load({ subagents: { agentTaskDescription: atCap } })).agentTaskDescription).toBe(
      atCap,
    );
    // Trimmed first: surrounding blanks do not count.
    expect(
      (await load({ subagents: { agentTaskDescription: `  ${atCap}\n` } })).agentTaskDescription,
    ).toBe(atCap);
    // One byte over, in far fewer than 4096 UTF-16 units.
    await expect(load({ subagents: { agentTaskDescription: `${atCap}x` } })).rejects.toThrow(
      /agentTaskDescription.*4096 bytes/,
    );
    await expect(
      load(
        { subagents: { agentTaskDescriptionFile: "big.md" } },
        { files: { "big.md": `${atCap}x` } },
      ),
    ).rejects.toThrow(/agentTaskDescriptionFile.*4096 bytes/);
  });
});

describe("a pod daemon's load (`podDaemon`)", () => {
  async function pod(config: unknown, runCommand: (command: string) => Promise<string>) {
    const configDir = dir();
    writeFileSync(join(configDir, "config.jsonc"), JSON.stringify(config));
    return loadConfig({
      configDir,
      cwd: dir(),
      scaffold: false,
      env: {},
      runCommand,
      podDaemon: true,
    });
  }

  test("an invalid inline description never fails the load: the laptop decides it", async () => {
    // Mutation: check the inline form under `podDaemon` too → ConfigError, over 4096 bytes.
    const never = async () => "";
    for (const text of ["x".repeat(5000), "   "]) {
      const c = await pod({ subagents: { agentTaskDescription: text } }, never);
      expect(c.agentTaskDescription).toBeUndefined();
    }
    const valid = await pod({ subagents: { agentTaskDescription: " mine " } }, never);
    expect(valid.agentTaskDescription).toBe("mine");
  });

  test("never runs apiKeyCommand: the key is the laptop's", async () => {
    const ran: string[] = [];
    const c = await pod({ model: { apiKeyCommand: "exit 7" } }, async (command) => {
      ran.push(command);
      throw new ConfigError("must not run");
    });
    expect(ran).toEqual([]);
    expect(c.apiKey).toBeUndefined();
  });

  test("never reads agentTaskDescriptionFile: a missing file cannot stop the daemon", async () => {
    const c = await pod(
      { subagents: { agentTaskDescriptionFile: "not-in-this-pod.md" } },
      async () => "",
    );
    expect(c.agentTaskDescription).toBeUndefined();
  });

  test("keeps the pod's inline text, for a bare open", async () => {
    const c = await pod({ subagents: { agentTaskDescription: "pod text" } }, async () => "");
    expect(c.agentTaskDescription).toBe("pod text");
  });

  test("without it the command still runs", async () => {
    const configDir = dir();
    writeFileSync(
      join(configDir, "config.jsonc"),
      JSON.stringify({ model: { apiKeyCommand: "x" } }),
    );
    const c = await loadConfig({
      configDir,
      cwd: dir(),
      scaffold: false,
      env: {},
      runCommand: async () => "the-key",
    });
    expect(c.apiKey).toBe("the-key");
  });
});

describe("provenance for the keys `sources` lacked", () => {
  test("unset → default", async () => {
    const { sources } = await load({});
    expect(sources.loadAgentsMd).toBe("default");
    expect(sources.loadSkills).toBe("default");
    expect(sources.contextAwarenessEnabled).toBe("default");
    expect(sources.contextAwarenessStepPercent).toBe("default");
    expect(sources.autoTitle).toBe("default");
  });

  test("set in the file to the DEFAULT value → file, not default", async () => {
    const { sources } = await load({
      loadAgentsMd: true,
      loadSkills: true,
      contextAwareness: { enabled: true, stepPercent: 1 },
      model: { autoTitle: false },
    });
    expect(sources.loadAgentsMd).toBe("file");
    expect(sources.loadSkills).toBe("file");
    expect(sources.contextAwarenessEnabled).toBe("file");
    expect(sources.contextAwarenessStepPercent).toBe("file");
    expect(sources.autoTitle).toBe("file");
  });

  test("the env's switches → env, whichever way they point; junk falls through", async () => {
    const off = await load({}, { env: { TENTACLE_NO_AGENTS_MD: "1", TENTACLE_NO_SKILLS: "1" } });
    expect(off.sources.loadAgentsMd).toBe("env");
    expect(off.sources.loadSkills).toBe("env");
    expect(off.agentsMdEnabled).toBe(false);
    expect(off.skillsEnabled).toBe(false);
    const on = await load({}, { env: { TENTACLE_NO_AGENTS_MD: "0", TENTACLE_NO_SKILLS: "0" } });
    expect(on.sources.loadAgentsMd).toBe("env");
    expect(on.agentsMdEnabled).toBe(true);
    const junk = await load({ loadSkills: false }, { env: { TENTACLE_NO_SKILLS: "maybe" } });
    expect(junk.sources.loadSkills).toBe("file");
    expect(junk.skillsEnabled).toBe(false);
  });

  test("a profile counts as the file", async () => {
    const { sources } = await load(
      { profiles: { p: { loadSkills: false, contextAwareness: { enabled: false } } } },
      { profile: "p" },
    );
    expect(sources.loadSkills).toBe("file");
    expect(sources.contextAwarenessEnabled).toBe("file");
    expect(sources.contextAwarenessStepPercent).toBe("default");
  });
});

describe("what a recompose needs is kept", () => {
  test("promptIdentity and agentsMdContent", async () => {
    const configDir = dir();
    writeFileSync(join(configDir, "PROMPT.md"), "IDENTITY");
    const cwd = dir();
    writeFileSync(join(cwd, "AGENTS.md"), "RULES");
    const c = await loadConfig({ configDir, cwd, scaffold: false, env: {} });
    expect(c.promptIdentity).toBe("IDENTITY");
    expect(c.agentsMdContent).toBe("RULES");
    expect(c.systemPrompt).toContain("RULES");
  });
});
