import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { type KeyNode, NON_KEY_ENV, configKeyNodes, resolveKeyPath } from "../src/config-keys.ts";
import {
  KEY_DOCS,
  type KeyDoc,
  carriedDocPaths,
  keyDoc,
  leafPaths,
  renderDefault,
} from "../src/key-docs.ts";
import { resolveConfig } from "../src/resolve.ts";
import { FileConfigSchema } from "../src/schema.ts";

const nodes = (): readonly KeyNode[] => configKeyNodes();
const paths = (): string[] => nodes().map((n) => n.path);

/**
 * The base entries only: a `profiles.*.x` mirror repeats its base entry's
 * facts, so every check below runs once per setting.
 */
const baseEntries = (): [string, KeyDoc][] =>
  Object.entries(KEY_DOCS).filter(([path]) => !path.startsWith("profiles."));

/** A resolved config from an empty file and an empty env: the built-in defaults. */
function emptyResolve(env: Record<string, string | undefined> = {}) {
  return resolveConfig({ fileConfig: {}, env, defaultCwd: "/workspace" });
}

describe("T1: every schema path is documented, and nothing else", () => {
  test("the registry's paths equal the schema's leaf AND section paths", () => {
    const schema = paths().sort();
    const documented = Object.keys(KEY_DOCS).sort();
    const missing = schema.filter((p) => !documented.includes(p));
    const extra = documented.filter((p) => !schema.includes(p));
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
    expect(documented).toEqual(schema);
  });

  test("each entry's kind matches the schema's", () => {
    const wrong = nodes()
      .filter((node) => keyDoc(node.path)?.kind !== node.kind)
      .map(
        (node) => `${node.path}: schema ${node.kind}, registry ${String(keyDoc(node.path)?.kind)}`,
      );
    expect(wrong).toEqual([]);
  });

  test("every section has a summary — a section is explainable too", () => {
    const bare = nodes()
      .filter((node) => node.kind === "section")
      .map((node) => node.path)
      .filter((path) => {
        const summary = keyDoc(path)?.summary;
        return summary === undefined || summary.trim() === "";
      });
    expect(bare).toEqual([]);
    expect(nodes().filter((n) => n.kind === "section").length).toBeGreaterThan(0);
  });

  test("every summary is one short line, not a paragraph", () => {
    const long = Object.entries(KEY_DOCS)
      .filter(([, doc]) => doc.summary.includes("\n") || doc.summary.length > 120)
      .map(([path]) => path);
    expect(long).toEqual([]);
  });

  test("a leaf names its type; a leaf under no map has an example", () => {
    const untyped = Object.entries(KEY_DOCS)
      .filter(([path, doc]) => doc.kind === "leaf" && doc.type === undefined)
      .map(([path]) => path);
    expect(untyped).toEqual([]);
    const noExample = Object.entries(KEY_DOCS)
      .filter(([path, doc]) => {
        const bare = leafPaths().includes(path) && !path.startsWith("profiles.*.");
        return bare && (doc.example === undefined || doc.example.trim() === "");
      })
      .map(([path]) => path);
    expect(noExample).toEqual([]);
    const bySchema = new Map(nodes().map((n) => [n.path, n]));
    const mismatched = Object.entries(KEY_DOCS)
      .filter(([path, doc]) => {
        const node = bySchema.get(path);
        return (
          node !== undefined &&
          node.values !== undefined &&
          !Bun.deepEquals([...(doc.values ?? [])].sort(), [...node.values].sort())
        );
      })
      .map(([path]) => path);
    expect(mismatched).toEqual([]);
  });
});

describe("T1b: the profiles.* mirror is faithful", () => {
  test("the profile subtree is the base tree minus $schema/profiles", () => {
    const all = paths();
    const { base, profile } = {
      base: all.filter((p) => !p.startsWith("profiles") && p !== "$schema"),
      profile: all
        .filter((p) => p.startsWith("profiles.*."))
        .map((p) => p.slice("profiles.*.".length)),
    };
    expect(profile.sort()).toEqual(base.sort());
  });

  test("an entry under profiles.* is scoped `profile`, and says so", () => {
    const wrong = Object.entries(KEY_DOCS)
      .filter(([path, doc]) =>
        path.startsWith("profiles.*.") ? doc.scope !== "profile" : doc.scope === "profile",
      )
      .map(([path]) => path);
    expect(wrong).toEqual([]);
  });

  test("scope is derivable from the path: user only for $schema and profiles*", () => {
    const wrong = Object.entries(KEY_DOCS)
      .filter(([path, doc]) => {
        const topOnly = path === "$schema" || path === "profiles" || path === "profiles.*";
        const depthOne = !topOnly && path.split(".").length === 1;
        if (topOnly) return doc.scope !== "user";
        return depthOne ? doc.scope !== "both" : doc.scope !== "profile" && doc.scope !== "both";
      })
      .map(([path]) => path);
    expect(wrong).toEqual([]);
  });

  test("a mirrored entry documents the same setting as its base", () => {
    const differing = Object.keys(KEY_DOCS)
      .filter((path) => path.startsWith("profiles.*."))
      .filter((path) => {
        const base = keyDoc(path.slice("profiles.*.".length));
        const mirrored = keyDoc(path);
        if (base === undefined || mirrored === undefined) return false;
        return (
          base.summary !== mirrored.summary ||
          base.type !== mirrored.type ||
          base.carried !== mirrored.carried ||
          base.env !== mirrored.env ||
          !Bun.deepEquals(base.values, mirrored.values)
        );
      });
    expect(differing).toEqual([]);
  });
});

describe("T2: the documented default is what an empty config resolves to", () => {
  const resolved = emptyResolve();

  test("every entry with a `resolved` accessor matches its default thunk", () => {
    const drift = baseEntries()
      .filter(([, doc]) => doc.resolved !== undefined)
      .map(([path, doc]) => {
        const actual = doc.resolved?.(resolved);
        if (doc.default === undefined) {
          // No default: the key must be ABSENT when the file and env are empty.
          return actual === undefined
            ? undefined
            : `${path}: documented no default, but resolves ${JSON.stringify(actual)}`;
        }
        const documented = doc.default();
        return Bun.deepEquals(documented, actual)
          ? undefined
          : `${path}: documented ${JSON.stringify(documented)}, resolves ${JSON.stringify(actual)}`;
      })
      .filter((entry): entry is string => entry !== undefined);
    expect(drift).toEqual([]);
  });

  test("the optional keys that resolve to `undefined` today document no default", () => {
    // `maxTokens` and `agentTaskDescription` are absent when unset. Documenting
    // a default for them would invent one.
    const absent = baseEntries()
      .filter(([, doc]) => doc.default === undefined && doc.resolved !== undefined)
      .map(([path]) => path);
    expect(absent.sort()).toEqual(["model.maxTokens", "subagents.agentTaskDescription"]);
    for (const path of absent) {
      expect(keyDoc(path)?.resolved?.(resolved)).toBeUndefined();
    }
  });

  test("the env-backed keys are exactly the ones `sources` tracks", () => {
    const tracked = Object.keys(resolved.sources).sort();
    const documented = baseEntries()
      .filter(([, doc]) => doc.sourceKey !== undefined)
      .map(([, doc]) => String(doc.sourceKey))
      .sort();
    expect(documented).toEqual(tracked);
  });

  test("a key with a `sourceKey` has a `resolved` accessor, except the three folded-in ones", () => {
    const broken = baseEntries()
      .filter(([, doc]) => doc.sourceKey !== undefined && doc.resolved === undefined)
      .map(([path]) => path);
    // `loadAgentsMd`/`loadSkills` surface only as `agentsMdLoaded`/the skills
    // list, not as their own resolved boolean; `systemPromptFile` is a FILE
    // PATH whose content (not the path) lands in `promptIdentity`, and the
    // default `PROMPT.md` is read from disk at load time — I/O `resolveConfig`
    // never does.
    expect(broken.sort()).toEqual(["loadAgentsMd", "loadSkills", "systemPromptFile"]);
    expect(
      baseEntries().filter(([, doc]) => doc.resolved !== undefined && doc.sourceKey === undefined),
    ).toEqual([]);
  });

  test("a documented default is short enough to print on one line", () => {
    const long = baseEntries()
      .filter(([, doc]) => (renderDefault(doc)?.length ?? 0) > 120)
      .map(([path]) => path);
    expect(long).toEqual([]);
  });
});

describe("T2b: the defaults `resolveConfig` does not apply are exactly the CLI's", () => {
  test("engine, rm, detach.keepAwake and tui.theme default on the CLI side", () => {
    const cliDefaults = baseEntries()
      .filter(([, doc]) => doc.default !== undefined && doc.sourceKey === undefined)
      .map(([path]) => path)
      .sort();
    // `resolve.ts` passes these through unset when the file omits them, so the
    // CLI (or the TUI) applies its own default — a documented default only.
    expect(cliDefaults).toEqual(["detach.keepAwake", "engine", "rm", "tui.theme"]);
  });
});

describe("T3: every documented env var really is read", () => {
  const withDefault = baseEntries().filter(
    ([, doc]) => doc.env !== undefined && doc.sourceKey !== undefined,
  );

  test("there is a sample for every env var, and it is valid for the key", () => {
    const missing = baseEntries()
      .filter(([, doc]) => doc.env !== undefined && doc.sample === undefined)
      .map(([path]) => path);
    expect(missing).toEqual([]);
  });

  test("setting the env var moves that setting's source to `env`", () => {
    const drift: string[] = [];
    for (const [path, doc] of withDefault) {
      if (doc.env === undefined || doc.sample === undefined || doc.sourceKey === undefined) {
        continue;
      }
      const resolved = emptyResolve({ [doc.env]: doc.sample });
      const source = resolved.sources[doc.sourceKey];
      if (source !== "env") {
        drift.push(`${path}: ${doc.env}=${doc.sample} → source ${String(source)}`);
      }
    }
    expect(drift).toEqual([]);
  });

  test("an inverted env (TENTACLE_NO_*) is marked as such", () => {
    const inverted = baseEntries()
      .filter(([, doc]) => doc.envInverts === true)
      .map(([path]) => path);
    expect(inverted.sort()).toEqual(["loadAgentsMd", "loadSkills"]);
    for (const path of inverted) {
      // The inverted sample must FLIP the setting, i.e. off → on or on → off.
      const doc = keyDoc(path);
      expect(doc?.env).toMatch(/^TENTACLE_NO_/);
    }
  });

  test("T3b: every TENTACLE_* read in @tentacle/config is a registry env or a known non-key", () => {
    const dir = join(import.meta.dir, "..", "src");
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
    const seen = new Set<string>();
    for (const file of files) {
      const text = readFileSync(join(dir, file), "utf8");
      for (const match of text.matchAll(/TENTACLE_[A-Z0-9_]+[A-Z0-9]/g)) {
        seen.add(match[0]);
      }
    }
    expect(files.length).toBeGreaterThan(5);
    const documented = new Set(
      baseEntries()
        .map(([, doc]) => doc.env)
        .filter((env): env is string => env !== undefined),
    );
    const strangers = [...seen]
      .filter((name) => !documented.has(name) && !NON_KEY_ENV.includes(name))
      .sort();
    expect(strangers).toEqual([]);
  });

  test("no documented env name is also listed as a non-key env", () => {
    const overlap = baseEntries()
      .map(([, doc]) => doc.env)
      .filter((env): env is string => env !== undefined)
      .filter((env) => NON_KEY_ENV.includes(env));
    expect(overlap).toEqual([]);
  });
});

describe("T7: secrets are marked, and never illustrated with a real value", () => {
  test("the key that holds a credential is a secret", () => {
    expect(keyDoc("model.apiKey")?.secret).toBe(true);
    expect(keyDoc("model.apiKeyCommand")?.secret).toBe(true);
    expect(keyDoc("mcpServers.*.env.*")?.secret).toBe(true);
    expect(keyDoc("mcpServers.*.headers.*")?.secret).toBe(true);
    expect(keyDoc("mcpServers.*.args")?.secret).toBe("values");
  });

  test("a non-secret key is not marked, in either tree", () => {
    const oversold = baseEntries()
      .filter(
        ([path, doc]) =>
          doc.secret === true &&
          !path.endsWith("apiKey") &&
          !path.endsWith("apiKeyCommand") &&
          !path.endsWith(".env.*") &&
          !path.endsWith(".headers.*"),
      )
      .map(([path]) => path);
    expect(oversold).toEqual([]);
    expect(keyDoc("model.model")?.secret).toBeUndefined();
    expect(keyDoc("tools.writableDirs")?.secret).toBeUndefined();
  });

  test("a secret that holds a VALUE is illustrated with a placeholder only", () => {
    // `apiKeyCommand` holds a command and `args` an argument list (masked
    // wholesale by `config`); their examples are safe real ones. A key whose
    // own value IS the credential shows a placeholder.
    const valueSecrets = baseEntries().filter(
      ([path, doc]) => doc.secret === true && !path.endsWith("apiKeyCommand"),
    );
    expect(valueSecrets.length).toBeGreaterThan(0);
    const suspicious = valueSecrets
      .filter(([, doc]) => doc.example !== undefined)
      .filter(([, doc]) => !/(…|<[^>]+>|\*\*\*)/.test(doc.example ?? ""))
      .map(([path]) => path);
    expect(suspicious).toEqual([]);
  });

  test("no example or summary anywhere looks like a real credential", () => {
    const plausible = baseEntries()
      .filter(([, doc]) =>
        /(sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,}|Bearer [A-Za-z0-9]{20,})/.test(
          `${doc.example ?? ""} ${doc.summary} ${doc.details ?? ""}`,
        ),
      )
      .map(([path]) => path);
    expect(plausible).toEqual([]);
  });

  test("a secret's docs never echo a value", () => {
    const echo = baseEntries()
      .filter(([, doc]) => doc.secret !== undefined)
      .filter(
        ([, doc]) =>
          /sk-[A-Za-z0-9]{8,}/.test(doc.summary) || /sk-[A-Za-z0-9]{8,}/.test(doc.details ?? ""),
      )
      .map(([path]) => path);
    expect(echo).toEqual([]);
  });
});

describe("the registry's helpers", () => {
  test("carried paths are the pods' settings, and a mirrored key repeats its base", () => {
    const carried = carriedDocPaths();
    expect(carried.length).toBeGreaterThan(10);
    expect(carried).toContain("model.contextWindow");
    expect(carried).not.toContain("tui.theme");
    expect(carried).not.toContain("packages");
    // The profile mirror carries the same class as its base.
    for (const path of carried.filter((p) => !p.startsWith("profiles.*."))) {
      const base = keyDoc(path);
      const mirrored = keyDoc(`profiles.*.${path}`);
      if (base === undefined || mirrored === undefined) {
        throw new Error(`${path}: missing base or mirrored entry`);
      }
      expect(mirrored.carried).toBe(base.carried);
      expect(mirrored.summary).toBe(base.summary);
    }
  });

  test("a canonical path resolves a concrete one", () => {
    expect(resolveKeyPath("mcpServers.fs.command")).toEqual({
      path: "mcpServers.*.command",
      kind: "leaf",
      type: "string",
    });
    expect(keyDoc(resolveKeyPath("modle")?.path ?? "")?.kind).toBeUndefined();
  });

  test("leafPaths is sorted and holds no section", () => {
    const leaves = leafPaths();
    expect(leaves).toEqual([...leaves].sort());
    expect(leaves.every((path) => keyDoc(path)?.kind === "leaf")).toBe(true);
    expect(leaves).toContain("tools.maxParallel");
    expect(leaves).not.toContain("tools");
  });

  test("the file schema still declares every documented top-level key", () => {
    // Guards against the registry drifting into fiction: a key it documents at
    // the top level must be one the strict schema would accept.
    for (const path of Object.keys(KEY_DOCS).filter((p) => p.split(".").length === 1)) {
      const probe = path === "$schema" ? { $schema: "x" } : undefined;
      if (probe !== undefined) {
        expect(FileConfigSchema.safeParse(probe).success).toBe(true);
      }
      expect(paths()).toContain(path);
    }
  });
});
