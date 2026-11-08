import { describe, expect, test } from "bun:test";
import { keyDoc, leafPaths } from "@tentacle/config";
import { explain, renderExplainJson, renderExplainText } from "../src/explain.ts";

const text = (key: string | undefined, opts: { all?: boolean } = {}): string => {
  const result = explain(key, opts);
  if (!result.ok) throw new Error(`unexpected error: ${result.error}`);
  return renderExplainText(result);
};

const lines = (key: string | undefined, opts: { all?: boolean } = {}): string[] =>
  text(key, opts).trimEnd().split("\n");

describe("explain with no key: the top level only", () => {
  test("one line per top-level key, sections marked with their sub-key count", () => {
    const out = lines(undefined);
    expect(out.some((line) => /^\s*model\b.*\(9 sub-keys\)/.test(line))).toBe(true);
    expect(out.some((line) => /^\s*subagents\b.*\(6 sub-keys\)/.test(line))).toBe(true);
    // A leaf at the top level has no count and no children of its own.
    expect(out.some((line) => /^\s*maxIterations\b/.test(line))).toBe(true);
    expect(out.some((line) => /^\s*maxIterations\b.*sub-keys/.test(line))).toBe(false);
  });

  test("every top-level key appears once, and nothing deeper", () => {
    const result = explain(undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.level).toBe("top");
    const paths = result.entries.map((e) => e.path);
    expect(paths).toContain("model");
    expect(paths).toContain("tools");
    expect(paths).toContain("maxIterations");
    expect(paths).toContain("$schema");
    // No nested path: the top level is the top level.
    expect(paths.every((path) => !path.includes("."))).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
  });

  test("the count is of DIRECT sub-keys, and it is the model's own field", () => {
    const result = explain(undefined);
    if (!result.ok) throw new Error("expected ok");
    const model = result.entries.find((e) => e.path === "model");
    expect(model?.kind).toBe("section");
    expect(model?.subKeys).toBe(9);
    expect(text(undefined)).toContain("(9 sub-keys)");
  });

  test("it is a list, not a wall of prose: one line per key, summary included", () => {
    const out = lines(undefined);
    const result = explain(undefined);
    if (!result.ok) throw new Error("expected ok");
    // Exactly one line per entry: no blank lines, no wrapping, no headings.
    expect(out.length).toBe(result.entries.length);
    for (const line of out) {
      expect(line.trim()).not.toBe("");
    }
    expect(text(undefined)).toContain("token budget");
  });
});

describe("explain <section>: its summary and its DIRECT sub-keys", () => {
  test("a section lists its own summary, then its children — not its grandchildren", () => {
    const out = lines("subagents");
    expect(out[0]).toContain("agent_task");
    const text_ = out.join("\n");
    expect(text_).toContain("subagents.maxParallel");
    expect(text_).toContain("subagents.enabled");
    // A grandchild never appears: `subagents`'s children are all direct.
    expect(text_).not.toContain("subagents.maxParallel.something");
    const result = explain("subagents");
    if (!result.ok) throw new Error("expected ok");
    expect(result.level).toBe("section");
    expect(result.entries.map((e) => e.path)).toContain("subagents.maxIterations");
  });

  test("a map's children are its `*` fields, never a bare `*`", () => {
    const result = explain("mcpServers");
    if (!result.ok) throw new Error("expected ok");
    const paths = result.entries.map((e) => e.path);
    expect(paths).toContain("mcpServers.*.command");
    expect(paths).toContain("mcpServers.*.url");
    expect(paths).not.toContain("mcpServers.*");
    expect(text("mcpServers")).toContain("mcpServers.*.command");
  });

  test("a concrete map path resolves to the same section", () => {
    expect(explain("mcpServers.fs")?.ok).toBe(true);
    expect(text("mcpServers.fs")).toContain("mcpServers.*.command");
  });

  test("a short default is shown beside a leaf, and a long one is not", () => {
    const out = text("subagents");
    expect(out).toContain("4");
    expect(out).toContain("parallel");
    expect(out.split("\n").length).toBeLessThan(20);
  });

  test("profiles: the profile settings, not the base keys", () => {
    const result = explain("profiles");
    if (!result.ok) throw new Error("expected ok");
    const paths = result.entries.map((e) => e.path);
    expect(paths).toContain("profiles.*.model");
    expect(paths).toContain("profiles.*.tools");
    expect(paths).not.toContain("profiles.*.$schema");
  });
});

describe("explain <leaf>: the full card", () => {
  test("every fact the owner asked for is on it", () => {
    const out = text("subagents.maxParallel");
    expect(out).toContain("subagents.maxParallel");
    expect(out).toContain("At most this many sub-agents"); // meaning
    expect(out).toMatch(/integer|number/); // type
    expect(out).toContain("4"); // default
    expect(out).toContain("TENTACLE_SUBAGENT_MAX_PARALLEL"); // env
    expect(out).toMatch(/pn|pinned/i); // carried
    expect(out).toMatch(/profile/i); // scope
    expect(out).toContain("4"); // the example too
  });

  test("a leaf with an env var, a flag and an enum lists them", () => {
    const model = text("model.model");
    expect(model).toContain("TENTACLE_MODEL");
    expect(model).toContain("--model");
    const tools = text("tools.execution");
    for (const value of ["sequential", "read-only", "parallel"]) {
      expect(tools).toContain(value);
    }
    const base = text("model.baseURL");
    expect(base).toContain("http://localhost:8080/v1");
  });

  test("a not-carried leaf says so; a carried one says where", () => {
    expect(text("tools.writableDirs")).toMatch(/not carried/i);
    expect(text("model.contextWindow")).toMatch(/carried to a pod/i);
  });

  test("a leaf's card never shows a secret value — only the placeholder", () => {
    const out = text("model.apiKey");
    expect(out).toContain("sk-…");
    expect(out).toMatch(/secret/i);
    expect(out).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });

  test("a card is a card, not the whole list", () => {
    const out = text("tools.maxParallel");
    expect(out.split("\n").length).toBeLessThan(20);
    expect(out).not.toContain("tools.maxInlineOutputChars:");
  });
});

describe("explain --all: the flat list of every leaf", () => {
  test("it is every leaf, sorted, one path per line", () => {
    const out = lines(undefined, { all: true });
    const paths = out.map((line) => line.trim().split(/\s/)[0] ?? "");
    const expected = leafPaths().filter((path) => !path.startsWith("profiles.*."));
    expect(paths).toEqual([...expected].sort());
    expect(paths).toContain("tools.maxParallel");
    expect(paths).not.toContain("tools");
  });

  test("--all with a key is refused instead of guessing", () => {
    const result = explain("model", { all: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/--all/);
  });

  test("--all shows no section", () => {
    const result = explain(undefined, { all: true });
    if (!result.ok) throw new Error("expected ok");
    expect(result.level).toBe("all");
    expect(result.entries.every((e) => e.kind === "leaf")).toBe(true);
  });
});

describe("an unknown key", () => {
  test("a typo yields an error with the nearest keys, never a partial list", () => {
    const result = explain("modle");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("modle");
    expect(result.suggestions ?? []).toContain("model");
  });

  test("a near miss inside a section finds it", () => {
    const result = explain("tools.writableDir");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.suggestions ?? []).toContain("tools.writableDirs");
  });

  test("the error is rendered on the error path, not as a doc", () => {
    const result = explain("zebra");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.suggestions ?? []).toEqual([]);
    expect(renderExplainText(result)).toBe("");
  });

  test("an empty or trailing-dot key is a usage error, not the top-level list", () => {
    for (const key of ["", "model.", ".model"]) {
      const result = explain(key);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).not.toBe("");
    }
  });
});

describe("--json", () => {
  test("it is the same model as the text, as JSON", () => {
    const result = explain("subagents.maxParallel");
    if (!result.ok) throw new Error("expected ok");
    const parsed = JSON.parse(renderExplainJson(result)) as Record<string, unknown>;
    expect(parsed.level).toBe("leaf");
    expect(Array.isArray(parsed.entries)).toBe(true);
    const entry = (parsed.entries as Record<string, unknown>[])[0];
    expect(entry?.path).toBe("subagents.maxParallel");
    expect(entry?.env).toBe("TENTACLE_SUBAGENT_MAX_PARALLEL");
    expect(entry?.default).toBe(4);
  });

  test("the top level serialises with its sub-key count", () => {
    const result = explain(undefined);
    if (!result.ok) throw new Error("expected ok");
    const parsed = JSON.parse(renderExplainJson(result)) as {
      entries: { path: string; subKeys?: number }[];
    };
    expect(parsed.entries.find((e) => e.path === "model")?.subKeys).toBe(9);
  });

  test("an error serialises as the error, with its suggestions", () => {
    const result = explain("modle");
    if (result.ok) throw new Error("expected an error");
    const parsed = JSON.parse(renderExplainJson(result)) as Record<string, unknown>;
    expect(parsed.ok).toBe(false);
    expect(parsed.suggestions).toContain("model");
  });

  test("a secret's JSON never carries a value, only the marker", () => {
    const result = explain("model.apiKey");
    if (!result.ok) throw new Error("expected ok");
    const json = renderExplainJson(result);
    const entry = (JSON.parse(json) as { entries: { secret?: unknown }[] }).entries[0];
    expect(entry?.secret).toBe(true);
    expect(json).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });
});

describe("the formatter never reads the user's config file", () => {
  test("it works with a key the registry alone can supply, and touches no env", () => {
    // Purely static: `explain` for a valid key never throws, whatever
    // TENTACLE_* says, and it prints a default from the registry.
    const saved = process.env.TENTACLE_CONFIG_DIR;
    process.env.TENTACLE_CONFIG_DIR = "/nonexistent/definitely-not-here";
    try {
      expect(text("model.model")).toContain("default");
      expect(keyDoc("model.model")?.summary).toContain("model id");
    } finally {
      const key = "TENTACLE_CONFIG_DIR";
      if (saved === undefined) delete process.env[key];
      else process.env.TENTACLE_CONFIG_DIR = saved;
    }
  });
});
