import { describe, expect, test } from "bun:test";
import { DEFAULT_MAX_ITERATIONS, DEFAULT_MODEL } from "@tentacle/config";
import {
  type EffectiveEntry,
  type EffectiveInput,
  effectiveEntries,
  effectiveEntry,
  effectiveLine,
  originText,
} from "../src/config-effective.ts";
import { DEFAULT_HIDE } from "../src/workspace-mount.ts";

/**
 * The EFFECTIVE view (docs/feat/config-list-effective.md). What is pinned here:
 * every known key is listed once, an unset key answers with its default, and the
 * origin is decided by the loader's own layering — never by a second precedence
 * table. Fakes: none needed — the module is pure, so a file object and an env
 * object stand in for the world.
 */

const view = (input: Omit<EffectiveInput, "env"> & { env?: EffectiveInput["env"] }) =>
  effectiveEntries({ ...input, env: input.env ?? {} });

const find = (entries: readonly EffectiveEntry[], path: string): EffectiveEntry => {
  const entry = entries.find((candidate) => candidate.path === path);
  if (entry === undefined) {
    throw new Error(`no entry for ${path}`); // no `!` assertions (§9 style)
  }
  return entry;
};

/** The line a user reads, which is what the owner's `grep` sees. */
const lineOf = (entries: readonly EffectiveEntry[], path: string): string =>
  effectiveLine(find(entries, path));

describe("T-E1: every known key is listed once, and only leaves", () => {
  test("the empty file's paths are the registry's leaves minus the profile mirror", () => {
    // Mutation: filter on something else, or skip the `*` expansion → the count
    // and the set move, and `config list | grep image` stops finding the key.
    const entries = view({ fileConfig: {} });
    const paths = entries.map((entry) => entry.path);
    expect(new Set(paths).size).toBe(paths.length); // once each
    // Sections are containers: `model` is not a setting, `model.images` is.
    expect(paths).not.toContain("model");
    expect(paths).toContain("model.images");
    // A map with no entry in the file keeps its pattern, so nothing is invented
    // and no known key is silently dropped.
    expect(paths).toContain("mcpServers.*.command");
    expect(paths).toContain("packages.*");
    // Sorted, so the output is stable and greppable whatever the file's order.
    expect(paths).toEqual([...paths].sort((a, b) => a.localeCompare(b)));
    expect(paths.length).toBeGreaterThan(60);
  });

  test("an unknown key is not in the view: nothing is invented", () => {
    const entries = view({ fileConfig: {} });
    expect(entries.some((entry) => entry.path.startsWith("model2"))).toBe(false);
    expect(effectiveEntry("model2", { fileConfig: {}, env: {} })).toBeUndefined();
  });
});

describe("T-E2: an unset key answers with the loader's own default", () => {
  test("the plain defaults are their values, not the registry's prose", () => {
    const entries = view({ fileConfig: {} });
    expect(lineOf(entries, "model.provider")).toBe('model.provider = "openai"  # default');
    expect(lineOf(entries, "maxIterations")).toBe(
      `maxIterations = ${DEFAULT_MAX_ITERATIONS}  # default`,
    );
    // A default that is runtime state is TEXT: a value would be a lie here.
    expect(lineOf(entries, "systemPromptFile")).toContain("`PROMPT.md` in the config dir");
    // …and one the loader never resolves comes from the module that owns it.
    expect(lineOf(entries, "mount.hide")).toBe(
      `mount.hide = ${JSON.stringify(DEFAULT_HIDE)}  # default`,
    );
  });
});

describe("T-E3: a default that depends on another key names it (the owner's example)", () => {
  test("model.images follows the provider, and says which one", () => {
    // Mutation: drop the note (or the image probe) → these three lines fail.
    expect(lineOf(view({ fileConfig: {} }), "model.images")).toBe(
      "model.images = false  # default (openai-compatible)",
    );
    expect(
      lineOf(view({ fileConfig: {}, env: { TENTACLE_PROVIDER: "anthropic" } }), "model.images"),
    ).toBe("model.images = true  # default (anthropic)");
    // The provider limit beside it, from the same `imageLimits()` the providers use.
    expect(
      lineOf(
        view({ fileConfig: {}, env: { TENTACLE_PROVIDER: "anthropic" } }),
        "model.maxImageBytes",
      ),
    ).toBe("model.maxImageBytes = 3932160  # default (anthropic)");
  });

  test("a value set in the file wins, and its origin says so", () => {
    const entries = view({ fileConfig: { model: { images: true } } });
    expect(lineOf(entries, "model.images")).toBe("model.images = true  # file");
  });

  test("`model.maxTokens` keeps the provider's own answer", () => {
    // openai: an OpenAI-compatible endpoint decides, so the text says so.
    expect(lineOf(view({ fileConfig: {} }), "model.maxTokens")).toContain("the server decides");
    expect(
      lineOf(view({ fileConfig: {}, env: { TENTACLE_PROVIDER: "anthropic" } }), "model.maxTokens"),
    ).toBe("model.maxTokens = 64000  # default (anthropic)");
  });
});

describe("T-E4: the origin is the loader's layering, not a second table", () => {
  test("file, env and default each name themselves", () => {
    const entries = view({
      fileConfig: { maxIterations: 8 },
      env: { TENTACLE_CONTEXT_WINDOW: "32000" },
    });
    expect(lineOf(entries, "maxIterations")).toBe("maxIterations = 8  # file");
    expect(lineOf(entries, "model.contextWindow")).toBe(
      "model.contextWindow = 32000  # env TENTACLE_CONTEXT_WINDOW",
    );
    expect(lineOf(entries, "model.model")).toBe(
      `model.model = ${JSON.stringify(DEFAULT_MODEL)}  # default`,
    );
  });

  test("a profile value says `profile <name>`, and an untouched key keeps the base origin", () => {
    const fileConfig = {
      maxIterations: 8,
      model: { model: "base-id" },
      profiles: { work: { model: { model: "work-id" } } },
    };
    const entries = view({ fileConfig, profile: "work" });
    expect(lineOf(entries, "model.model")).toBe('model.model = "work-id"  # profile work');
    // The profile sets no `maxIterations`: the file's value is still the origin,
    // not `profile work` (the merged file holds it, the profile does not set it).
    expect(lineOf(entries, "maxIterations")).toBe("maxIterations = 8  # file");
    // Without `--profile` the file's own value is what resolves.
    expect(lineOf(view({ fileConfig }), "model.model")).toBe('model.model = "base-id"  # file');
  });

  test("an unparseable env value never claims `env`: the loader ignores it", () => {
    // Mutation: read `env[doc.env] !== undefined` alone → these become `env …`
    // while the loader is in fact using the default.
    const entries = view({
      fileConfig: {},
      env: { TENTACLE_PROVIDER: "nonsense", TENTACLE_MAX_ITERATIONS: "abc" },
    });
    expect(lineOf(entries, "model.provider")).toBe('model.provider = "openai"  # default');
    expect(lineOf(entries, "maxIterations")).toBe(
      `maxIterations = ${DEFAULT_MAX_ITERATIONS}  # default`,
    );
  });

  test("an inverted env var is reported as env, with the boolean, not its text", () => {
    const entries = view({ fileConfig: {}, env: { TENTACLE_NO_AGENTS_MD: "1" } });
    expect(lineOf(entries, "loadAgentsMd")).toBe(
      "loadAgentsMd = false  # env TENTACLE_NO_AGENTS_MD",
    );
    expect(lineOf(view({ fileConfig: {} }), "loadAgentsMd")).toBe("loadAgentsMd = true  # default");
  });
});

describe("T-E5: secrets stay masked, and nothing leaks", () => {
  test("a stored secret is masked on the line and in the value", () => {
    const secret = "sk-MUSTNOTAPPEAR";
    const entries = view({ fileConfig: { model: { apiKey: secret } } });
    const entry = find(entries, "model.apiKey");
    expect(effectiveLine(entry)).toBe("model.apiKey = ***  # file");
    expect(entry.value).toBe("***");
    expect(JSON.stringify(entries)).not.toContain(secret);
    // An MCP server's args and env are secret by registry (`[***]`, `***`).
    const mcp = view({
      fileConfig: {
        mcpServers: {
          fs: { type: "stdio" as const, command: "mcp-fs", args: [secret], env: { TOKEN: secret } },
        },
      },
    });
    expect(lineOf(mcp, "mcpServers.fs.args")).toBe("mcpServers.fs.args = [***]  # file");
    expect(lineOf(mcp, "mcpServers.fs.env.TOKEN")).toBe("mcpServers.fs.env.TOKEN = ***  # file");
    expect(JSON.stringify(mcp)).not.toContain(secret);
  });
});

describe("T-E6: maps and arrays", () => {
  test("a map's entries are listed by their real names; the pattern goes away", () => {
    const entries = view({
      fileConfig: { mcpServers: { fs: { type: "stdio" as const, command: "mcp-fs" } } },
    });
    expect(lineOf(entries, "mcpServers.fs.command")).toBe(
      'mcpServers.fs.command = "mcp-fs"  # file',
    );
    expect(entries.some((entry) => entry.path === "mcpServers.*.command")).toBe(false);
    // A field the entry does not set is unset for that entry too.
    expect(lineOf(entries, "mcpServers.fs.url")).toBe("mcpServers.fs.url = (unset)  # no default");
  });

  test("a models entry inherits from the main model, and says so", () => {
    const entries = view({
      fileConfig: {
        model: { model: "qwen3" },
        models: { fast: { description: "quick" } },
        subagents: { types: { plan: { model: "fast" } } },
      },
    });
    expect(lineOf(entries, "models.fast.model")).toBe(
      'models.fast.model = "qwen3"  # default (from model)',
    );
    expect(lineOf(entries, "models.fast.description")).toBe(
      'models.fast.description = "quick"  # file',
    );
    // The entry sets no `images`: the note says where it came from, not which
    // provider it happens to be — the inherited value IS the main model's.
    expect(lineOf(entries, "models.fast.images")).toBe(
      "models.fast.images = false  # default (from model)",
    );
  });

  test("an array is one line, as JSON", () => {
    const entries = view({ fileConfig: { tools: { writableDirs: ["/tmp"] } } });
    expect(lineOf(entries, "tools.writableDirs")).toBe('tools.writableDirs = ["/tmp"]  # file');
  });
});

describe("T-E7: the printed form", () => {
  test("each origin reads as its trailing comment", () => {
    expect(originText({ kind: "file" })).toBe("file");
    expect(originText({ kind: "profile", name: "work" })).toBe("profile work");
    expect(originText({ kind: "env", name: "TENTACLE_MODEL" })).toBe("env TENTACLE_MODEL");
    expect(originText({ kind: "default" })).toBe("default");
    expect(originText({ kind: "default", note: "anthropic" })).toBe("default (anthropic)");
    expect(originText({ kind: "unset" })).toBe("no default");
  });

  test("an unknown profile lists nothing (the caller refuses it first)", () => {
    expect(view({ fileConfig: { profiles: { work: {} } }, profile: "nope" })).toEqual([]);
  });
});
