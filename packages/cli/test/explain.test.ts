import { describe, expect, test } from "bun:test";
import { keyDoc, leafPaths, renderConfigKeysTable } from "@tentacle/config";
import {
  explain,
  explainErrorText,
  promptHint,
  renderExplainJson,
  renderExplainText,
} from "../src/explain.ts";

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
    expect(out.some((line) => /^\s*model\b.*\(11 sub-keys\)/.test(line))).toBe(true);
    // 10 since subagent-token-budget (`subagents.maxTokens`).
    expect(out.some((line) => /^\s*subagents\b.*\(10 sub-keys\)/.test(line))).toBe(true);
    // 12 since attachments-prompt (`models.*.images`).
    expect(out.some((line) => /^\s*models\b.*\(12 sub-keys\)/.test(line))).toBe(true);
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

  test("$schema is listed, LAST — a pointer for editors, not a setting", () => {
    // Review O2: keep it explainable, but do not open the list with it.
    const result = explain(undefined);
    if (!result.ok) throw new Error("expected ok");
    const paths = result.entries.map((e) => e.path);
    expect(paths[0]).not.toBe("$schema");
    expect(paths[paths.length - 1]).toBe("$schema");
  });

  test("the count is of DIRECT sub-keys, and it is the model's own field", () => {
    const result = explain(undefined);
    if (!result.ok) throw new Error("expected ok");
    const model = result.entries.find((e) => e.path === "model");
    expect(model?.kind).toBe("section");
    expect(model?.subKeys).toBe(11);
    expect(text(undefined)).toContain("(11 sub-keys)");
  });

  test("it is a list, not a wall of prose: one line per key on a wide terminal", () => {
    // The form (no blank lines, no headings, no wrapping) is asserted at a
    // width wide enough for every summary — where it must hold. At 80 a
    // summary may CONTINUE under its column (review LOW 6), which the next
    // test pins; what may never happen is a blank line or a lost entry.
    const result = explain(undefined);
    if (!result.ok) throw new Error("expected ok");
    const out = renderExplainText(result, { width: 200 }).trimEnd().split("\n");
    expect(out.length).toBe(result.entries.length);
    for (const line of out) {
      expect(line.trim()).not.toBe("");
    }
    expect(text(undefined)).toContain("token budget");
    // Every key is named at the head of its own line, exactly once.
    // The path as a whole word: `model` must not also count the `models` line.
    for (const entry of result.entries) {
      expect(out.filter((line) => line.trimStart().split(/\s/)[0] === entry.path).length).toBe(1);
    }
  });

  test("at 80 columns the summary wraps under its column, and no entry is lost", () => {
    const result = explain(undefined);
    if (!result.ok) throw new Error("expected ok");
    const out = renderExplainText(result, { width: 80 }).trimEnd().split("\n");
    // Still a list: no blank line, and each entry's summary is reachable by
    // joining the continuation lines back onto their head.
    for (const line of out) {
      expect(line.trim()).not.toBe("");
    }
    const joined = out.map((line) => line.trim()).join(" ");
    for (const entry of result.entries) {
      expect(joined).toContain(entry.summary.replace(/\s+/g, " "));
    }
    expect(out.filter((line) => line.trimStart().startsWith("model")).length).toBeGreaterThan(0);
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

  test("a section prints its details between its summary and its children", () => {
    for (const key of ["models", "profiles", "model"]) {
      const details = keyDoc(key)?.details;
      if (details === undefined) throw new Error(`no details for ${key}`);
      const result = explain(key);
      if (!result.ok) throw new Error(`expected ok for ${key}`);
      const out = renderExplainText(result, { width: 100000 }).split("\n");
      expect(out[0]?.startsWith(`${key} — `)).toBe(true);
      expect(out.slice(1, 4)).toEqual(["", details, ""]);
      expect(out[4]?.startsWith(`  ${key}.`)).toBe(true);
    }
  });

  test("a section with no details keeps its summary directly above its children", () => {
    expect(keyDoc("subagents")?.details).toBeUndefined();
    const out = lines("subagents");
    expect(out[1]).toBe("");
    expect(out[2]?.startsWith("  subagents.")).toBe(true);
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
    // 9 direct sub-keys since subagent-token-budget, most wrapping once at 80
    // columns.
    expect(out.split("\n").length).toBeLessThan(26);
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

  test("F4: the allowlist keys say the laptop publishes them and a pod's own value is ignored", () => {
    for (const path of ["subagents.selectableModels", "subagents.types.*.model"]) {
      expect(text(path)).toContain("published by the laptop: a pod's own value is ignored");
      expect(text(path)).not.toContain("a pod uses its own value");
    }
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
    expect(parsed.entries.find((e) => e.path === "model")?.subKeys).toBe(11);
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

describe("width: the output fits the terminal (LOW 6)", () => {
  const wide = (out: string, width: number): string[] =>
    out
      .trimEnd()
      .split("\n")
      .filter((line) => line.length > width);

  test("at 80 columns every level fits, with no sentence broken mid-word", () => {
    for (const key of [
      undefined,
      "model",
      "models",
      "subagents",
      "tools",
      "mcpServers",
      "profiles",
    ]) {
      const result = explain(key);
      if (!result.ok) throw new Error(`expected ok for ${String(key)}`);
      expect({ key, wide: wide(renderExplainText(result, { width: 80 }), 80) }).toEqual({
        key,
        wide: [],
      });
    }
  });

  test("a leaf card fits too, details and all", () => {
    // `tools.writableDirs` has the longest `details` in the registry (~1200 chars).
    for (const key of [
      "tools.writableDirs",
      "tools.redactSecrets",
      "model.apiKey",
      "mcpServers.*.readOnlyTools",
      "hooks",
    ]) {
      const result = explain(key);
      if (!result.ok) throw new Error(`expected ok for ${key}`);
      expect({ key, wide: wide(renderExplainText(result, { width: 80 }), 80) }).toEqual({
        key,
        wide: [],
      });
    }
  });

  test("80 is the default when the terminal does not say", () => {
    const result = explain(undefined);
    if (!result.ok) throw new Error("expected ok");
    expect(renderExplainText(result)).toBe(renderExplainText(result, { width: 80 }));
  });

  test("a narrow terminal is honoured, not overflowed", () => {
    const result = explain("subagents");
    if (!result.ok) throw new Error("expected ok");
    expect(wide(renderExplainText(result, { width: 60 }), 60)).toEqual([]);
  });

  test("it is still one line per key when it does fit", () => {
    // The wrap must not break the list shape on a wide terminal.
    const result = explain("subagents");
    if (!result.ok) throw new Error("expected ok");
    const rows = renderExplainText(result, { width: 200 }).trimEnd().split("\n");
    // Its own summary line, a blank, then one line per child.
    expect(rows.length).toBe(result.entries.length + 2);
  });

  test("a path wider than the whole column still fits, its summary below it", () => {
    // At 80 the longest path (`profiles.*.subagents.agentTaskDescriptionFile`)
    // still leaves a column; at a narrower one the summary wraps under the path
    // rather than pushing the line past the width.
    for (const width of [60, 70, 80]) {
      const result = explain("profiles");
      if (!result.ok) throw new Error("expected ok");
      expect({ width, wide: wide(renderExplainText(result, { width }), width) }).toEqual({
        width,
        wide: [],
      });
    }
  });
});

describe("a multi-word key is a prompt, not a typo (LOW 2 / O1)", () => {
  test("the result flags it, and `main` answers with `tentacle -- <prompt>`", () => {
    const result = explain("explain how config works");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    // `explain` cannot know the whole argv, so it reports the INTENT; `main`
    // builds the line from the argv the old build would have sent.
    expect(result.prompt).toBe(true);
    // No "did you mean": the words are a sentence, not a misspelt key.
    expect(result.suggestions).toEqual([]);
    const hint = promptHint(["explain", "explain how config works"]);
    expect(hint).toBe(
      "to send this as a prompt, use: tentacle -- explain explain how config works",
    );
    expect(explainErrorText(result, { hint })).toContain(
      "to send this as a prompt, use: tentacle --",
    );
  });

  test("a single misspelt word still gets its suggestions, not the prompt hint", () => {
    const result = explain("modle");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.prompt).toBeUndefined();
    expect(result.suggestions).toContain("model");
  });

  test("a sentence under a known section is a prompt too", () => {
    const result = explain("tools how do I write to tmp");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.prompt).toBe(true);
  });
});

describe("defaults that are runtime state are text, not a value (LOW 5)", () => {
  test('tools.writableDirs shows the real default, not `["/tmp"]`', () => {
    const out = text("tools.writableDirs");
    expect(out).toContain("$TMPDIR");
    expect(out).toContain("/tmp");
    expect(out).not.toContain('["/tmp"]');
  });

  test("the list line and the README table use the same text", () => {
    const listed = text("tools");
    // Long defaults are not put on a list line; the card carries it.
    expect(listed).not.toContain('["/tmp"]');
    expect(renderConfigKeysTable()).toContain("the system temp dir (`$TMPDIR`) and `/tmp`");
  });

  test("the env format from the old README row is still shown (LOW 7)", () => {
    expect(text("tools.writableDirs")).toContain(":`-separated; empty = `[]`");
    expect(renderConfigKeysTable()).toContain(":`-separated; empty = `[]`");
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
