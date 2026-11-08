import { describe, expect, test } from "bun:test";
import { type KeyNode, configKeyNodes, nearestKeys, resolveKeyPath } from "../src/config-keys.ts";
import { FileConfigSchema } from "../src/schema.ts";

const paths = (nodes: readonly KeyNode[]): string[] => nodes.map((n) => n.path);
const node = (path: string): KeyNode => {
  const found = configKeyNodes().find((n) => n.path === path);
  if (found === undefined) throw new Error(`no node ${path}`);
  return found;
};

describe("the schema walker", () => {
  test("tells a section from a leaf, and a record from an array", () => {
    expect(node("model").kind).toBe("section");
    expect(node("model.provider").kind).toBe("leaf");
    // The MCP server is a preprocess + discriminated union: still a section,
    // whose fields are the union of its branches' fields.
    expect(node("mcpServers.*").kind).toBe("section");
    expect(node("mcpServers.*.command").kind).toBe("leaf");
    expect(node("mcpServers.*.url").kind).toBe("leaf");
    // A record is a map section with exactly one child, its `*` entry.
    expect(node("mcpServers.*.env").kind).toBe("section");
    expect(node("mcpServers.*.env").type).toBe("map");
    expect(node("mcpServers.*.env.*").kind).toBe("leaf");
    expect(node("mcpServers.*.env.*").type).toBe("string");
    expect(node("packages").type).toBe("map");
    expect(node("packages.*").kind).toBe("leaf");
    expect(node("packages.*").type).toBe("boolean");
    // A union of plain values (readOnlyTools) is a leaf, never an empty section.
    expect(node("mcpServers.*.readOnlyTools").kind).toBe("leaf");
    expect(node("mcpServers.*.readOnlyTools").values).toEqual(["hint", "none"]);
    // An array of objects (hooks) is a leaf: its element fields are not keys.
    expect(node("hooks").kind).toBe("leaf");
    expect(node("hooks").type).toBe("array");
    expect(node("tools.writableDirs").type).toBe("array");
    expect(node("model.maxTokens").type).toBe("integer");
    expect(node("model.baseURL").type).toBe("string");
    expect(node("model.autoTitle").type).toBe("boolean");
    expect(node("model.provider").values).toEqual(["openai", "anthropic"]);
    // A literal inside the union: `stdio` or `http`, merged across branches.
    expect(node("mcpServers.*.type").values).toEqual(["stdio", "http"]);
  });

  test("walks profiles the same way the file's own settings are walked", () => {
    const all = paths(configKeyNodes());
    const base = all.filter(
      (p) => !p.startsWith("profiles.") && p !== "profiles" && p !== "$schema",
    );
    const profile = all
      .filter((p) => p.startsWith("profiles.*."))
      .map((p) => p.slice("profiles.*.".length));
    expect(profile).toEqual(base);
  });

  test("every path is unique and the walk is deterministic", () => {
    const all = paths(configKeyNodes());
    expect(new Set(all).size).toBe(all.length);
    expect(paths(configKeyNodes())).toEqual(all);
  });

  test("every path under a map is written with a `*` segment", () => {
    const mapChildren = configKeyNodes().filter((n) => n.path.includes("*"));
    expect(mapChildren.length).toBeGreaterThan(0);
    for (const child of mapChildren) {
      expect(child.path).toMatch(/(^|\.)\*/);
    }
    // A record has exactly one child: its `*` entry.
    const env = configKeyNodes().filter((n) => n.path.startsWith("mcpServers.*.env"));
    expect(env.map((n) => n.path)).toEqual(["mcpServers.*.env", "mcpServers.*.env.*"]);
  });

  test("a section is listed before its children (top-level order is the file's)", () => {
    const all = paths(configKeyNodes());
    expect(all.slice(0, 3)).toEqual(["$schema", "model", "model.provider"]);
    expect(all.indexOf("model")).toBeLessThan(all.indexOf("model.provider"));
    expect(all.indexOf("model.maxTokens")).toBeLessThan(all.indexOf("hooks"));
  });

  test("it is the file schema it walks, not a copy of it", () => {
    expect(paths(configKeyNodes())).toContain("$schema");
    expect(paths(configKeyNodes())).toContain("profiles.*.mcpServers.*.command");
    // `ProfileSchema` alone has no `$schema`/`profiles`: proof the walker does
    // not hard-code a path list.
    expect(FileConfigSchema.safeParse({}).success).toBe(true);
  });
});

describe("resolveKeyPath", () => {
  test("a `*` segment accepts any name, and the answer is the canonical path", () => {
    expect(resolveKeyPath("model")?.path).toBe("model");
    expect(resolveKeyPath("mcpServers.fs.command")?.path).toBe("mcpServers.*.command");
    expect(resolveKeyPath("mcpServers.fs.env.TOKEN")?.path).toBe("mcpServers.*.env.*");
    expect(resolveKeyPath("profiles.work.model.model")?.path).toBe("profiles.*.model.model");
    expect(resolveKeyPath("profiles.work")?.path).toBe("profiles.*");
    // Written literally, it is the same node.
    expect(resolveKeyPath("mcpServers.*.command")?.path).toBe("mcpServers.*.command");
  });

  test("an unknown or half-written path is undefined, never the whole tree", () => {
    expect(resolveKeyPath("modle")).toBeUndefined();
    expect(resolveKeyPath("model.providr")).toBeUndefined();
    expect(resolveKeyPath("model.provider.x")).toBeUndefined();
    expect(resolveKeyPath("")).toBeUndefined();
    expect(resolveKeyPath(".")).toBeUndefined();
    expect(resolveKeyPath("model.")).toBeUndefined();
    expect(resolveKeyPath(" model")).toBeUndefined();
    expect(resolveKeyPath("mcpServers.")).toBeUndefined();
    // `*` is not a name a user may give for a record's key.
    expect(resolveKeyPath("mcpServers*.command")).toBeUndefined();
  });
});

describe("nearestKeys", () => {
  const all = paths(configKeyNodes());

  test("a transposed word finds the key", () => {
    expect(nearestKeys("modle", all)[0]).toBe("model");
    expect(nearestKeys("subagentz.maxParallel", all)[0]).toBe("subagents.maxParallel");
  });

  test("a near-miss on the last segment finds it", () => {
    expect(nearestKeys("tools.writableDir", all)[0]).toBe("tools.writableDirs");
    expect(nearestKeys("contextReset.maxPerMessag", all)[0]).toBe("contextReset.maxPerMessage");
  });

  test("at most three, most likely first, never the whole list", () => {
    const found = nearestKeys("modle", all);
    expect(found.length).toBeLessThanOrEqual(3);
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found).size).toBe(found.length);
    // A map key given concretely still points at the `*` entry.
    expect(nearestKeys("mcpServers.fs.comand", all)).toContain("mcpServers.*.command");
  });

  test("an unrelated word gets nothing rather than noise", () => {
    expect(nearestKeys("zebra", all)).toEqual([]);
    expect(nearestKeys("", all)).toEqual([]);
    expect(nearestKeys("model", [])).toEqual([]);
  });
});
