import { describe, expect, test } from "bun:test";
import { type KeyNode, configKeyNodes, resolveKeyPath } from "../src/config-keys.ts";
import {
  appliesToText,
  checkSegments,
  flattenStored,
  isArgvRefusedSecret,
  maskStored,
  renderStored,
  secretOf,
  secretPathsIn,
  typeConfigValue,
} from "../src/config-value.ts";
import { keyDoc } from "../src/key-docs.ts";

/** The secret paths an argv value would put under `segments` (HIGH-1). */
function argvSecretPaths(value: unknown, segments: readonly string[]): readonly string[] {
  return secretPathsIn(value, segments);
}

/** The schema node a concrete key names, asserting it is a leaf of `type`. */
function leaf(key: string): KeyNode {
  const node = resolveKeyPath(key);
  if (node === undefined) {
    throw new Error(`no schema node for ${key}`);
  }
  return node;
}

/** Type `text` for `key`, returning the value or the error string. */
function typed(key: string, text: string): unknown {
  const result = typeConfigValue(leaf(key), text);
  if (!result.ok) {
    throw new Error(`unexpected refusal for ${key}=${text}: ${result.error}`);
  }
  return result.value;
}

function refusal(key: string, text: string): string {
  const result = typeConfigValue(leaf(key), text);
  if (result.ok) {
    throw new Error(`expected a refusal for ${key}=${text}, got ${JSON.stringify(result.value)}`);
  }
  return result.error;
}

describe("A3/Q5: the value is typed by the schema leaf", () => {
  test("boolean: only true and false", () => {
    expect(typed("autoWake", "true")).toBe(true);
    expect(typed("autoWake", "false")).toBe(false);
    // Mutation: `value === "true" ? true : value` (a "1"/"yes"/anything guess) → these pass wrongly.
    expect(refusal("autoWake", "1")).toContain("true or false");
    expect(refusal("autoWake", "yes")).toContain("true or false");
    expect(refusal("autoWake", "TRUE")).toContain("true or false");
  });

  test("integer: a decimal with an optional sign; not a float", () => {
    expect(typed("maxIterations", "20")).toBe(20);
    expect(typed("maxIterations", "-1")).toBe(-1);
    expect(refusal("maxIterations", "2.5")).toContain("integer");
    expect(refusal("maxIterations", "abc")).toContain("integer");
    expect(refusal("maxIterations", "")).toContain("integer");
  });

  test("enum: a listed value, and the message names them", () => {
    expect(typed("tools.execution", "parallel")).toBe("parallel");
    expect(typed("tui.theme", "light")).toBe("light");
    const error = refusal("tools.execution", "parallelism");
    expect(error).toContain("sequential");
    expect(error).toContain("read-only");
    expect(error).toContain("parallel");
  });

  test("string: raw text as is, and a JSON string is that string", () => {
    // The common case needs no quoting (owner Q5).
    expect(typed("model.baseURL", "http://localhost:8080/v1")).toBe("http://localhost:8080/v1");
    expect(typed("model.model", "qwen3")).toBe("qwen3");
    // A leading `"` that parses as a JSON string is accepted as that string, so a
    // quote never silently becomes part of a path/URL (eval A3).
    expect(typed("model.baseURL", '"http://x:1/v1"')).toBe("http://x:1/v1");
    expect(typed("model.model", '"a b"')).toBe("a b");
    // A quote that does not parse is text, not an error: the schema decides.
    expect(typed("model.model", '"unterminated')).toBe('"unterminated');
  });

  test("array: JSON, and a plain word is refused with the form to use", () => {
    expect(typed("tools.writableDirs", '["/tmp","~/x"]')).toEqual(["/tmp", "~/x"]);
    expect(typed("tools.writableDirs", "[]")).toEqual([]);
    const error = refusal("tools.writableDirs", "/tmp:~/x");
    expect(error).toContain("JSON array");
  });

  test("object/map: a whole section is JSON too", () => {
    expect(typed("mcpServers.fs", '{"command":"mcp-fs"}')).toEqual({ command: "mcp-fs" });
    expect(typed("subagents", '{"enabled":false}')).toEqual({ enabled: false });
    expect(refusal("subagents", "true")).toContain("JSON object");
  });

  test("a union leaf takes its enum members, else the array form", () => {
    expect(typed("mcpServers.fs.readOnlyTools", "none")).toBe("none");
    expect(typed("mcpServers.fs.readOnlyTools", '["read_file"]')).toEqual(["read_file"]);
    expect(refusal("mcpServers.fs.readOnlyTools", "50")).toContain("hint");
  });

  test("an error names the type and the key, never a secret value", () => {
    const error = refusal("subagents.maxParallel", "sk-nope");
    expect(error).toContain("integer");
    expect(error).not.toContain("sk-nope");
  });
});

describe("A4: which keys hold a secret", () => {
  test("the registry decides, in both trees", () => {
    expect(secretOf("model.apiKey")).toBe(true);
    expect(secretOf("mcpServers.fs.env.TOKEN")).toBe(true);
    expect(secretOf("mcpServers.fs.headers.Authorization")).toBe(true);
    expect(secretOf("mcpServers.fs.args")).toBe("values");
    expect(secretOf("profiles.work.model.apiKey")).toBe(true);
    expect(secretOf("profiles.work.mcpServers.fs.env.TOKEN")).toBe(true);
    expect(secretOf("model.model")).toBeUndefined();
    expect(secretOf("tools.writableDirs")).toBeUndefined();
  });

  test("argv is refused for a credential, not for apiKeyCommand", () => {
    // Mutation: refuse every `secret: true` → the documented `apiKeyCommand` set
    // from argv (which the eval's A4 explicitly allows) fails.
    expect(isArgvRefusedSecret("model.apiKey")).toBe(true);
    expect(isArgvRefusedSecret("profiles.work.model.apiKey")).toBe(true);
    expect(isArgvRefusedSecret("mcpServers.fs.env.TOKEN")).toBe(true);
    expect(isArgvRefusedSecret("mcpServers.fs.headers.Authorization")).toBe(true);
    expect(isArgvRefusedSecret("mcpServers.fs.args")).toBe(true);
    expect(isArgvRefusedSecret("model.apiKeyCommand")).toBe(false);
    expect(isArgvRefusedSecret("model.model")).toBe(false);
  });
});

describe("T9: masked printing never emits the value", () => {
  const SECRET = "sk-live-2f8a";

  test("a secret leaf is ***, in both trees", () => {
    expect(renderStored(SECRET, ["model", "apiKey"])).toBe("***");
    expect(renderStored(SECRET, ["profiles", "work", "model", "apiKey"])).toBe("***");
    expect(renderStored(SECRET, ["mcpServers", "fs", "env", "TOKEN"])).toBe("***");
    expect(renderStored("Bearer x", ["mcpServers", "fs", "headers", "Authorization"])).toBe("***");
  });

  test("args is [***] wholesale (a token is often an argument)", () => {
    const rendered = renderStored(["--token", SECRET], ["mcpServers", "fs", "args"]);
    expect(rendered).toBe("[***]");
    expect(rendered).not.toContain(SECRET);
  });

  test("an object recurses, masking only what is secret", () => {
    const rendered = renderStored(
      { command: "mcp-fs", args: ["--token", SECRET], env: { TOKEN: SECRET } },
      ["mcpServers", "fs"],
    );
    expect(rendered).toContain('"command":"mcp-fs"');
    expect(rendered).toContain('"args":[***]');
    expect(rendered).toContain('"TOKEN":***');
    expect(rendered).not.toContain(SECRET);
  });

  test("a non-secret value prints as the JSON the file holds", () => {
    expect(renderStored(20, ["maxIterations"])).toBe("20");
    expect(renderStored("qwen3", ["model", "model"])).toBe('"qwen3"');
    expect(renderStored(["/tmp"], ["tools", "writableDirs"])).toBe('["/tmp"]');
  });

  test("list flattens to leaf lines, sorted, and nothing secret survives", () => {
    const file = {
      model: { model: "qwen3", apiKey: SECRET },
      subagents: { maxParallel: 3 },
      tools: { writableDirs: ["/tmp"] },
      mcpServers: { fs: { command: "mcp-fs", args: ["--token", SECRET], env: { TOKEN: SECRET } } },
    };
    const lines = flattenStored(file);
    const text = lines.map((line) => `${line.path} = ${line.text}`).join("\n");
    expect(lines.map((line) => line.path)).toEqual([
      "mcpServers.fs.args",
      "mcpServers.fs.command",
      "mcpServers.fs.env.TOKEN",
      "model.apiKey",
      "model.model",
      "subagents.maxParallel",
      "tools.writableDirs",
    ]);
    expect(text).toContain("model.apiKey = ***");
    expect(text).toContain('model.model = "qwen3"');
    expect(text).toContain("mcpServers.fs.args = [***]");
    expect(text).not.toContain(SECRET);
  });

  test("a secret's subtree is masked line by line, never a partial leak", () => {
    const lines = flattenStored({ mcpServers: { fs: { env: { A: SECRET, B: SECRET } } } });
    expect(lines).toEqual([
      { path: "mcpServers.fs.env.A", text: "***", value: "***" },
      { path: "mcpServers.fs.env.B", text: "***", value: "***" },
    ]);
  });

  test("an unknown key is a plain leaf line, value in clear", () => {
    // Before: one masked `model.foo` line. Now it flattens like any setting, so a
    // typo'd nested object is visible key by key.
    expect(flattenStored({ model: { foo: "hello-typo", bar: { a: 1 } } })).toEqual([
      { path: "model.bar.a", text: "1", value: 1 },
      { path: "model.foo", text: '"hello-typo"', value: "hello-typo" },
    ]);
    // …while a secret map under an unknown name still stops the walk, per child.
    expect(flattenStored({ mcpServers: { fs: { env: { ANYTHING: SECRET } } } })).toEqual([
      { path: "mcpServers.fs.env.ANYTHING", text: "***", value: "***" },
    ]);
  });

  test("an empty object is one line, and an empty file lists nothing", () => {
    expect(flattenStored({})).toEqual([]);
    expect(flattenStored({ hooks: [] })).toEqual([{ path: "hooks", text: "[]", value: [] }]);
    expect(flattenStored({ profiles: {} })).toEqual([{ path: "profiles", text: "{}", value: {} }]);
  });

  test("each line carries its masked VALUE too, so `list --json` never re-reads one", () => {
    const lines = flattenStored({ model: { apiKey: SECRET, model: "qwen3" } });
    expect(lines).toEqual([
      { path: "model.apiKey", text: "***", value: "***" },
      { path: "model.model", text: '"qwen3"', value: "qwen3" },
    ]);
    expect(JSON.stringify(lines.map((l) => l.value))).not.toContain(SECRET);
  });
});

describe("HIGH-2/Q-B: maskStored is the ONLY source of a printed stored value", () => {
  const SECRET = "sk-live-m4sk";

  test("a secret leaf becomes *** and a secret array [***], in both trees", () => {
    expect(maskStored(SECRET, ["model", "apiKey"])).toBe("***");
    expect(maskStored(["a", SECRET], ["mcpServers", "fs", "args"])).toEqual(["***"]);
    expect(maskStored({ TOKEN: SECRET }, ["mcpServers", "fs", "env", "TOKEN"])).toBe("***");
    expect(maskStored(SECRET, ["profiles", "work", "model", "apiKey"])).toBe("***");
  });

  test("a models entry's key and key command are masked, in both trees (models-map)", () => {
    const masked = maskStored(
      {
        models: { claude: { model: "sonnet", apiKey: SECRET, apiKeyCommand: `echo ${SECRET}` } },
        profiles: { p: { models: { claude: { apiKey: SECRET } } } },
      },
      [],
    );
    expect(masked).toEqual({
      models: { claude: { model: "sonnet", apiKey: "***", apiKeyCommand: "***" } },
      profiles: { p: { models: { claude: { apiKey: "***" } } } },
    });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect(isArgvRefusedSecret("models.claude.apiKey")).toBe(true);
    expect(isArgvRefusedSecret("profiles.p.models.claude.apiKey")).toBe(true);
    expect(isArgvRefusedSecret("models.claude.apiKeyCommand")).toBe(false);
  });

  test("an object is masked inside, and never leaks a secret value", () => {
    // The HIGH-2 hole: `get model --json` emitted the raw object.
    const masked = maskStored({ model: "qwen3", apiKey: SECRET }, ["model"]);
    expect(masked).toEqual({ model: "qwen3", apiKey: "***" });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
    const mcp = maskStored(
      { command: "mcp-fs", args: ["--token", SECRET], env: { TOKEN: SECRET } },
      ["mcpServers", "fs"],
    );
    expect(mcp).toEqual({ command: "mcp-fs", args: ["***"], env: { TOKEN: "***" } });
    expect(JSON.stringify(mcp)).not.toContain(SECRET);
  });

  test("a whole section of profiles masks every secret under it", () => {
    const file = {
      work: { model: { model: "qwen3", apiKey: SECRET }, mcpServers: null },
    };
    const masked = maskStored(file, ["profiles"]);
    expect(JSON.stringify(masked)).not.toContain(SECRET);
    expect(JSON.stringify(masked)).toContain("qwen3");
  });

  test("an unknown key's value is IN CLEAR (owner 2026-11-08: Q-B rejected)", () => {
    // A typo, or a key in the wrong place, must be diagnosable from `list`/`get`:
    // only the registry's secret set masks. (docs/fix/config-unknown-plain.md)
    const file = { model: { foo: "hello-typo" }, tools: { execution: SECRET } };
    expect(maskStored(file, [])).toEqual(file);
    // A key outside the schema entirely (a misplaced section), value and all.
    expect(maskStored({ bogus: { a: "b" } }, [])).toEqual({ bogus: { a: "b" } });
    // …and inside a profile, against the `profiles.*` mirror.
    expect(maskStored({ p: { nope: "x" } }, ["profiles"])).toEqual({ p: { nope: "x" } });
    // The boundary, stated so it is a decision and not a surprise: the owner's rule
    // is the registry, so a credential-shaped value at a path the registry does not
    // know (`model2.apiKey` — a misplaced `apiKey`) is in clear too. Masking by NAME
    // would need a second table of secrets, which is what A4 forbids.
    expect(maskStored({ model2: { apiKey: "sk-x" } }, [])).toEqual({ model2: { apiKey: "sk-x" } });
  });

  test("an unknown NAME under a secret map is STILL a secret", () => {
    // The one thing the unknown-key rule must not have been holding up: `env` and
    // `headers` are secret per CHILD (`mcpServers.*.env.*`), so a name the registry
    // does not list (ANYTHING, Y) is masked by the registry, not by "unknown".
    const masked = maskStored(
      { fs: { env: { ANYTHING: SECRET }, headers: { Y: `Bearer ${SECRET}` } } },
      ["mcpServers"],
    );
    expect(masked).toEqual({ fs: { env: { ANYTHING: "***" }, headers: { Y: "***" } } });
    expect(JSON.stringify(masked)).not.toContain(SECRET);
  });

  test("a non-secret value is the value (get/list keep working)", () => {
    expect(maskStored(20, ["maxIterations"])).toBe(20);
    expect(maskStored(["/tmp"], ["tools", "writableDirs"])).toEqual(["/tmp"]);
    expect(maskStored({ enabled: true }, ["subagents"])).toEqual({ enabled: true });
    expect(maskStored({}, ["subagents"])).toEqual({});
    // The file itself (no path) is walked, not masked.
    expect(maskStored({ maxIterations: 8 })).toEqual({ maxIterations: 8 });
  });

  test("renderStored of the masked tree never emits a SECRET (list/get plain)", () => {
    const file = { model: { model: "qwen3", apiKey: SECRET }, bogus: "typo-value" };
    const text = flattenStored(maskStored(file))
      .map((l) => `${l.path} = ${l.text}`)
      .join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).toContain("model.apiKey = ***");
    // Not a secret, so not masked: what the user pasted is what they see.
    expect(text).toContain('bogus = "typo-value"');
  });
});

describe("HIGH-1: a secret inside an argv value, at its target path", () => {
  test("a secret nested in an object is found, with its concrete path", () => {
    // `config model='{"apiKey":"sk-x"}'`: the KEY is not secret, its value is.
    expect(argvSecretPaths({ apiKey: "sk-x" }, ["model"])).toEqual(["model.apiKey"]);
    expect(argvSecretPaths({ apiKey: "sk-x" }, ["profiles", "p", "model"])).toEqual([
      "profiles.p.model.apiKey",
    ]);
    expect(argvSecretPaths({ T: "sk-x" }, ["mcpServers", "fs", "env"])).toEqual([
      "mcpServers.fs.env.T",
    ]);
    expect(argvSecretPaths({ model: { apiKey: "sk-x" } }, ["profiles", "p"])).toEqual([
      "profiles.p.model.apiKey",
    ]);
    // A whole server: `args` is a secret ARRAY, `env`/`headers` maps of secrets.
    expect(
      argvSecretPaths({ command: "x", args: ["--token", "sk-x"], env: { A: "sk-x" }, cwd: "." }, [
        "mcpServers",
        "fs",
      ]),
    ).toEqual(["mcpServers.fs.args", "mcpServers.fs.env.A"]);
  });

  test("the secret leaf itself is found (the whole-object form of the leaf case)", () => {
    expect(argvSecretPaths("sk-x", ["model", "apiKey"])).toEqual(["model.apiKey"]);
    expect(argvSecretPaths(["--token", "sk-x"], ["mcpServers", "fs", "args"])).toEqual([
      "mcpServers.fs.args",
    ]);
  });

  test("apiKeyCommand stays the documented safe form, and nothing else is named", () => {
    expect(argvSecretPaths({ apiKeyCommand: "pass show x" }, ["model"])).toEqual([]);
    expect(argvSecretPaths({ command: "mcp-fs", cwd: "." }, ["mcpServers", "fs"])).toEqual([]);
    expect(argvSecretPaths({ enabled: false }, ["subagents"])).toEqual([]);
    expect(argvSecretPaths("qwen3", ["model", "model"])).toEqual([]);
  });
});

describe("A5: a key path and a map entry's name", () => {
  test("a dotted path splits into plain names", () => {
    expect(checkSegments("model.model")).toEqual({ ok: true, segments: ["model", "model"] });
    expect(checkSegments("profiles.work.model.model")).toEqual({
      ok: true,
      segments: ["profiles", "work", "model", "model"],
    });
    expect(checkSegments("$schema")).toEqual({ ok: true, segments: ["$schema"] });
    expect(checkSegments("mcpServers.my-server.env.A_B")).toEqual({
      ok: true,
      segments: ["mcpServers", "my-server", "env", "A_B"],
    });
  });

  test("an empty segment, a space or a quote is refused, naming the form", () => {
    for (const bad of ["", ".", "model.", "a..b", "model .model", 'model.model"']) {
      const result = checkSegments(bad);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error).toBeTruthy();
    }
  });
});

describe("A6: what the write applies to", () => {
  const text = (path: string): string => {
    const doc = keyDoc(path);
    if (doc === undefined) throw new Error(`no doc for ${path}`);
    return appliesToText(doc);
  };

  test("always: sessions started after this, and a running serve keeps its value", () => {
    for (const path of ["model.model", "subagents.maxParallel", "tools.writableDirs"]) {
      expect(text(path)).toContain("sessions started after this");
      expect(text(path)).toContain("serve");
      expect(text(path)).toContain("until restarted");
    }
  });

  test("a carried key says it goes to a pod; a non-carried one says it does not", () => {
    // Mutation: read `carried` from the wrong field → these two swap.
    expect(text("subagents.maxParallel")).toContain("carried to a pod");
    expect(text("model.contextWindow")).toContain("carried to a pod");
    expect(text("tools.writableDirs")).toContain("not carried");
    expect(text("tui.theme")).toContain("not carried");
  });

  test("a published key says the laptop publishes it and a pod's own value is ignored", () => {
    // Mutation: drop the `published` branch → it would say "carried to a pod".
    for (const path of ["subagents.selectableModels", "subagents.types.*.model"]) {
      expect(text(path)).toContain("published by the laptop");
      expect(text(path)).toContain("a pod's own value is ignored");
      expect(text(path)).not.toContain("not carried");
    }
  });

  test("it is one line", () => {
    expect(text("model.model").includes("\n")).toBe(false);
  });
});

describe("the typing uses the schema walker's type, not a second table", () => {
  test("every leaf the registry documents has a type the walker knows", () => {
    const known = new Set([
      "boolean",
      "string",
      "integer",
      "number",
      "enum",
      "array",
      "map",
      "object",
      "enum|array",
    ]);
    const unknown = configKeyNodes()
      .filter((node) => node.kind === "leaf")
      .filter((node) => !known.has(node.type))
      .map((node) => `${node.path}: ${node.type}`);
    expect(unknown).toEqual([]);
  });
});
