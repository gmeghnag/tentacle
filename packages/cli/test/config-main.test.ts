import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { USAGE, cliMode } from "../src/flags.ts";
import { main } from "../src/index.ts";

/** Piped stdin and stdout, whatever terminal runs the suite (CliIO.terminal). */
const NO_TERMINAL = { stdin: false, stdout: false };

let dir: string;
let configDir: string;
let configPath: string;
const savedConfigDir = process.env.TENTACLE_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tentacle-config-main-"));
  configDir = join(dir, "cfg");
  configPath = join(configDir, "config.jsonc");
  process.env.TENTACLE_CONFIG_DIR = configDir;
});

afterEach(() => {
  const key = "TENTACLE_CONFIG_DIR";
  if (savedConfigDir === undefined) delete process.env[key];
  else process.env.TENTACLE_CONFIG_DIR = savedConfigDir;
});

interface Run {
  readonly code: number;
  readonly out: string;
  readonly err: string;
}

async function run(
  args: readonly string[],
  io: {
    stdin?: NodeJS.ReadableStream;
    readSecret?: (prompt: string) => Promise<string>;
    readStdin?: () => Promise<string>;
  } = {},
): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["bun", "cli", "config", ...args], {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    terminal: NO_TERMINAL,
    ...(io.readSecret !== undefined ? { readSecret: io.readSecret } : {}),
    ...(io.readStdin !== undefined ? { readStdin: io.readStdin } : {}),
  });
  return { code, out: out.join(""), err: err.join("") };
}

/** The file's bytes, hashed — T8's "nothing was written" observable. */
const sha = (path: string): string =>
  createHash("sha256").update(readFileSync(path, "utf8")).digest("hex");

/** A commented file, the shape the scaffold leaves behind. */
const FIXTURE = `{
  // tentacle configuration.
  //
  // Uncomment a setting to override the default shown in the comment.

  "model": {
    // Model id sent to the endpoint.
    // "model": "qwen3",
  },

  // Max model/tool iterations per turn.
  // "maxIterations": 48, // -1 = unlimited
}
`;

function seeded(): void {
  mkdirSync(configDir, { recursive: true });
  writeFileSync(configPath, FIXTURE);
}

describe("T8: refused before writing — the file's bytes are unchanged", () => {
  test("a type error", async () => {
    // Mutation: validate after the write → the file's sha changes here.
    seeded();
    const before = sha(configPath);
    const { code, out, err } = await run(["subagents.maxParallel=abc"]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("integer");
    expect(err).toContain("subagents.maxParallel");
    expect(sha(configPath)).toBe(before);
  });

  test("an unknown key, with the nearest suggestion", async () => {
    seeded();
    const before = sha(configPath);
    const { code, err } = await run(["modle.model=x"]);
    expect(code).toBe(1);
    expect(err).toContain("unknown config key");
    expect(err).toContain("did you mean");
    expect(err).toContain("model.model");
    expect(sha(configPath)).toBe(before);
  });

  test("a cross-field violation on the WHOLE result", async () => {
    seeded();
    const first = await run(["subagents.agentTaskDescription=do this"]);
    expect(first.code).toBe(0);
    const before = sha(configPath);
    const second = await run(["subagents.agentTaskDescriptionFile=desc.md"]);
    expect(second.code).toBe(1);
    expect(second.err).toContain("not both");
    expect(sha(configPath)).toBe(before);
  });

  test("a broken file: set refuses, `unset` of the broken key is allowed", async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, '{\n  "model": { "provider": "nope" },\n  "maxIterations": 8\n}\n');
    const before = sha(configPath);
    const refused = await run(["autoWake=true"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("model.provider");
    expect(sha(configPath)).toBe(before);
    // The unset validates the RESULT, so removing the offending key works.
    const fixed = await run(["unset", "model", "--yes"]);
    expect(fixed.code).toBe(0);
    expect(readFileSync(configPath, "utf8")).not.toContain("provider");
  });

  test("a file that does not parse is refused with every parse error", async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, '{ "a": , "b": , }\n');
    const before = sha(configPath);
    const { code, err } = await run(["autoWake=true"]);
    expect(code).toBe(1);
    expect(err).toContain("not valid JSONC");
    expect(sha(configPath)).toBe(before);
    // `get` and `list` refuse the same way: they cannot honestly answer.
    expect((await run(["get", "model.model"])).code).toBe(1);
    expect((await run(["list"])).code).toBe(1);
    expect((await run(["list"])).err).toContain("not valid JSONC");
  });
});

describe("T9: a secret never reaches argv, and never reaches the output", () => {
  const SECRET = "sk-test-4b91";

  test("argv is refused, and the whole output is free of the value", async () => {
    seeded();
    const before = sha(configPath);
    const { code, out, err } = await run([`model.apiKey=${SECRET}`]);
    expect(code).toBe(1);
    expect(`${out}${err}`).not.toContain(SECRET);
    expect(err).toContain("model.apiKey");
    expect(err).toContain("stdin");
    expect(err).toContain("apiKeyCommand");
    expect(sha(configPath)).toBe(before);
    // `set k v` is the same road.
    const spaced = await run(["set", "model.apiKey", SECRET]);
    expect(spaced.code).toBe(1);
    expect(`${spaced.out}${spaced.err}`).not.toContain(SECRET);
  });

  test("stdin is accepted (one trailing newline trimmed) and reported as plaintext", async () => {
    seeded();
    // Piped stdin, no value: `main`'s seam stands in for `-` (the same code path
    // as `Bun.stdin.text()`, deterministically).
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["bun", "cli", "config", "model.apiKey", "-"], {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      terminal: { stdin: false, stdout: false },
      readStdin: async () => `${SECRET}\n`,
    });
    expect(code).toBe(0);
    expect(err.join("")).not.toContain(SECRET);
    expect(out.join("")).not.toContain(SECRET);
    expect(out.join("")).toContain("stored in plaintext");
    // Exactly one trailing newline is trimmed, and nothing else.
    expect(readFileSync(configPath, "utf8")).toContain(`"apiKey": "${SECRET}"`);
  });

  test("with no value on a terminal, the prompt is hidden and its answer is stored", async () => {
    // The real default reader (`readHiddenLine`) needs a TTY; this pins the
    // WIRING instead: terminal stdin + no value → the `readSecret` seam runs, and
    // its answer is what gets stored (eval A4's third safe form).
    seeded();
    const prompts: string[] = [];
    const out: string[] = [];
    const code = await main(["bun", "cli", "config", "model.apiKey"], {
      out: (text) => out.push(text),
      err: () => undefined,
      terminal: { stdin: true, stdout: true },
      readSecret: async (prompt) => {
        prompts.push(prompt);
        return `${SECRET}\n`;
      },
    });
    expect(code).toBe(0);
    expect(prompts).toEqual(["model.apiKey: "]);
    expect(out.join("")).toContain("stored in plaintext");
    expect(out.join("")).not.toContain(SECRET);
    expect(readFileSync(configPath, "utf8")).toContain(SECRET);
  });

  test("the file is written 0600, and `get`/`list` print ***", async () => {
    seeded();
    const written = await main(["bun", "cli", "config", "model.apiKey", "-"], {
      out: () => undefined,
      err: () => undefined,
      terminal: NO_TERMINAL,
      readStdin: async () => `${SECRET}\n`,
    });
    expect(written).toBe(0);
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain(SECRET); // it IS stored: that is what plaintext means
    // The value is never printed by get/list:
    const got = await run(["get", "model.apiKey"]);
    expect(got.code).toBe(0);
    expect(got.out.trim()).toBe("***");
    expect(got.out).not.toContain(SECRET);
    const listed = await run(["list"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("model.apiKey = ***");
    expect(listed.out).not.toContain(SECRET);
    // …not in the JSON forms either.
    const json = await run(["get", "model.apiKey", "--json"]);
    expect(json.out).not.toContain(SECRET);
    // A group/world-readable file is warned about, not chmodded silently.
    chmodSync(configPath, 0o644);
    const warn: string[] = [];
    const again = await main(["bun", "cli", "config", "model.apiKey", "-"], {
      out: () => undefined,
      err: (text) => warn.push(text),
      terminal: NO_TERMINAL,
      readStdin: async () => SECRET,
    });
    expect(again).toBe(0);
    expect(warn.join("")).toContain("readable by other users");
    // The write kept the file's own mode (it never chmods behind the user's back).
    expect(statSync(configPath).mode & 0o777).toBe(0o644);
  });

  test("an apiKeyCommand IS accepted from argv (the documented safe form)", async () => {
    seeded();
    const { code } = await run(["model.apiKeyCommand=pass show tentacle"]);
    expect(code).toBe(0);
    expect(readFileSync(configPath, "utf8")).toContain("pass show tentacle");
  });

  test("an MCP server's env/headers/args are masked in list", async () => {
    seeded();
    // Seeded through stdin: the object form on ARGV is refused now (HIGH-1).
    const written = await main(["bun", "cli", "config", "mcpServers.fs", "-"], {
      out: () => undefined,
      err: () => undefined,
      terminal: NO_TERMINAL,
      readStdin: async () =>
        '{"command":"mcp-fs","args":["--token","tok-123"],"env":{"TOKEN":"tok-456"}}\n',
    });
    expect(written).toBe(0);
    const listed = await run(["list"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("mcpServers.fs.args = [***]");
    expect(listed.out).toContain("mcpServers.fs.env.TOKEN = ***");
    expect(listed.out).not.toContain("tok-123");
    expect(listed.out).not.toContain("tok-456");
  });
});

describe("the command surface (owner Q7)", () => {
  test("`config` is a subcommand, with its own usage line", () => {
    expect(cliMode(["config", "list"])).toBe("config");
    expect(USAGE.config).toContain("tentacle config set");
    // `config` no longer swallows a prompt without saying so.
    expect(cliMode(["config"])).toBe("config");
  });

  test("--help lists the config command (main's HELP)", async () => {
    const out: string[] = [];
    const code = await main(["bun", "cli", "--help"], {
      out: (text) => out.push(text),
      err: () => undefined,
      terminal: NO_TERMINAL,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("tentacle config set");
  });

  test("path prints the file, and creates nothing", async () => {
    const { code, out } = await run(["path"]);
    expect(code).toBe(0);
    expect(out.trim()).toBe(configPath);
    expect(existsSync(configPath)).toBe(false);
  });

  test("get on a missing file exits 1, list exits 0", async () => {
    const got = await run(["get", "model.model"]);
    expect(got.code).toBe(1);
    expect(got.err).toContain("no config file");
    const listed = await run(["list"]);
    expect(listed.code).toBe(0);
    expect(listed.err).toContain("no config file");
  });

  test("a set prints the value, the path and what it applies to (A6)", async () => {
    seeded();
    const { code, out } = await run(["set", "subagents.maxParallel", "3"]);
    expect(code).toBe(0);
    expect(out).toContain("set subagents.maxParallel = 3 in");
    expect(out).toContain(configPath);
    expect(out).toContain("sessions started after this");
    expect(out).toContain("carried to a pod");
    // The scaffold's comments are still there, byte for byte.
    expect(readFileSync(configPath, "utf8")).toContain("// Max model/tool iterations per turn.");
  });

  test("get prints the value as stored; an unset key answers with its effective value", async () => {
    seeded();
    await run(["subagents.maxParallel=3"]);
    const got = await run(["get", "subagents.maxParallel"]);
    expect(got.code).toBe(0);
    expect(got.out.trim()).toBe("3");
    // A set key is unchanged: the stored value alone, no comment.
    await run(["model.model=qwen3"]);
    const stored = await run(["get", "model.model"]);
    expect(stored.code).toBe(0);
    expect(stored.out.trim()).toBe('"qwen3"');
  });

  test("get on an unset key prints the effective value and its origin, exit 0", async () => {
    // The owner's rule (2026-11-13): the error is gone, the answer takes its
    // place. Mutation: restore the old `not set` refusal → both fail.
    seeded();
    const images = await run(["get", "model.images"]);
    expect(images.code).toBe(0);
    expect(images.out.trim()).toBe("model.images = false  # default (openai-compatible)");
    const limit = await run(["get", "model.maxImageBytes"]);
    expect(limit.code).toBe(0);
    expect(limit.out.trim()).toBe("model.maxImageBytes = 5242880  # default (openai-compatible)");
    // An env var is an origin too, and the value follows it.
    process.env.TENTACLE_PROVIDER = "anthropic";
    try {
      const anthropic = await run(["get", "model.images"]);
      expect(anthropic.out.trim()).toBe("model.images = true  # default (anthropic)");
    } finally {
      process.env.TENTACLE_PROVIDER = undefined;
    }
  });

  test("get on a key with NO value at all still refuses, and an unknown key still refuses", async () => {
    seeded();
    // A key with no default and nothing set has no effective value to print.
    const unset = await run(["get", "model.titleModel"]);
    expect(unset.code).toBe(1);
    expect(unset.err).toContain("is not set");
    // An unknown key is refused before anything is computed (unchanged).
    const unknown = await run(["get", "model2"]);
    expect(unknown.code).toBe(1);
    expect(unknown.err).toContain("unknown config key");
  });

  test("a parseable file that fails the schema: `get`/`list` still answer", async () => {
    // They are how a user finds the offending key, so they must read a file whose
    // settings are wrong — only a file that does not PARSE stops them.
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, '{\n  "model": { "provider": "nope" },\n  "maxIterations": 8\n}\n');
    const got = await run(["get", "maxIterations"]);
    expect(got.code).toBe(0);
    expect(got.out.trim()).toBe("8");
    const listed = await run(["list"]);
    expect(listed.code).toBe(0);
    expect(listed.out).toContain('model.provider = "nope"  # file');
    expect(listed.out).toContain("maxIterations = 8  # file");
  });

  test("a value of the wrong SHAPE never crashes the effective view", async () => {
    // `list` runs BEFORE the loader, on the file as written, so a wrong shape is
    // a thing to answer for — never a TypeError. The loader itself refuses these
    // loudly at startup; this view just must not be the thing that dies.
    mkdirSync(configDir, { recursive: true });
    const shapes = [
      '{\n  "model": "not-an-object",\n  "profiles": { "work": { "tools": 5 } }\n}\n',
      '{\n  "maxIterations": "abc",\n  "subagents": 5,\n  "hooks": "x"\n}\n',
    ];
    for (const text of shapes) {
      writeFileSync(configPath, text);
      const plain = await run(["list"]);
      expect(plain.code).toBe(0);
      expect(plain.out).toContain("model.images = false  # default (openai-compatible)");
      const withProfile = await run(["list", "--profile", "work"]);
      // Shape 1 defines `profiles.work` (badly); shape 2 defines none at all — an
      // unknown profile is refused in words, and a bad one still answers.
      expect(`${withProfile.out}${withProfile.err}`).not.toContain("TypeError");
      if (withProfile.code === 0) {
        expect(withProfile.out).toContain("model.images = false  # default");
      } else {
        expect(withProfile.err).toContain("no profile");
      }
    }
    // A file that is not a JSON OBJECT at all: refused, in words, not walked.
    writeFileSync(configPath, '"x"\n');
    const notObject = await run(["list"]);
    expect(notObject.code).toBe(1);
    expect(notObject.err).toContain("a config file is a JSON object");
  });

  test("a map entry is created from one leaf, and the schema infers `type`", async () => {
    seeded();
    // eval A5: `McpServerSchema` infers `stdio` from a command and `http` from a url.
    expect((await run(["mcpServers.fs.command=mcp-fs"])).code).toBe(0);
    expect((await run(["mcpServers.web.url=https://mcp.example.com/mcp"])).code).toBe(0);
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain('"fs"');
    expect(text).toContain('"web"');
    // The inferred type survives a re-read by the real loader's schema.
    const listed = await run(["list", "--json"]);
    expect(listed.code).toBe(0);
  });

  test("a map-of-boolean entry, and a whole-object set, both validate", async () => {
    seeded();
    expect((await run(["packages.some-pkg=false"])).code).toBe(0);
    expect((await run(["subagents", '{"enabled":false,"maxParallel":2}'])).code).toBe(0);
    const listed = await run(["list"]);
    expect(listed.out).toContain("packages.some-pkg = false");
    expect(listed.out).toContain("subagents.maxParallel = 2");
  });

  test("$schema is a plain string at the top level (and refused in a profile)", async () => {
    seeded();
    const set = await run(["$schema=./config.schema.json"]);
    expect(set.code).toBe(0);
    expect(readFileSync(configPath, "utf8")).toContain('"$schema": "./config.schema.json"');
    const got = await run(["get", "$schema"]);
    expect(got.out.trim()).toBe('"./config.schema.json"');
  });

  test("--json is machine-readable for get and list", async () => {
    seeded();
    await run(["subagents.maxParallel=3"]);
    const got = JSON.parse((await run(["get", "subagents.maxParallel", "--json"])).out) as unknown;
    expect(got).toEqual({ key: "subagents.maxParallel", value: 3 });
    const listed = JSON.parse((await run(["list", "--set", "--json"])).out) as unknown;
    expect(listed).toEqual({ model: {}, "subagents.maxParallel": 3 });
    // The default `--json` form is the effective array, with an origin per key.
    const effective = JSON.parse((await run(["list", "--json"])).out) as {
      path: string;
      value: unknown;
      origin: string;
    }[];
    const images = effective.find((entry) => entry.path === "model.images");
    expect(images).toEqual({
      path: "model.images",
      value: false,
      origin: "default (openai-compatible)",
    });
    const set = effective.find((entry) => entry.path === "subagents.maxParallel");
    expect(set).toEqual({ path: "subagents.maxParallel", value: 3, origin: "file" });
  });

  test("--profile targets profiles.<name> in the same file", async () => {
    seeded();
    const { code, out } = await run(["set", "model.model", "qwen3-coder", "--profile", "work"]);
    expect(code).toBe(0);
    expect(out).toContain("profiles.work.model.model");
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain('"profiles"');
    expect(text).toContain('"work"');
    const got = await run(["get", "model.model", "--profile", "work"]);
    expect(got.out.trim()).toBe('"qwen3-coder"');
    const listed = await run(["list", "--profile", "work"]);
    expect(listed.out).toContain('model.model = "qwen3-coder"  # profile work');
  });

  test("list: every known key with its effective value and origin (owner 2026-11-13)", async () => {
    // The repro of this task, turned green: the unset `model.images` is listed —
    // so `config list | grep image` finds it — with the default it really has.
    // Mutation: make `list` print only the file again → every assertion fails.
    seeded();
    await run(["maxIterations=8"]);
    const { code, out } = await run(["list"]);
    expect(code).toBe(0);
    expect(out).toContain("model.images = false  # default (openai-compatible)");
    expect(out).toContain("maxIterations = 8  # file");
    expect(out.split("\n").filter((line) => line.includes("image")).length).toBeGreaterThan(1);
    // Every known leaf, one line each, and the file's unknown key still shown.
    const paths = out
      .trim()
      .split("\n")
      .map((line) => line.split(" = ")[0]);
    expect(new Set(paths).size).toBe(paths.length);
    expect(paths).toContain("model.maxImageBytes");
    expect(paths).toContain("tui.theme");
    expect(paths).not.toContain("model"); // a section is not a setting
    // A key with no value at all says so instead of inventing one.
    expect(out).toContain("model.titleModel = (unset)  # no default");
  });

  test("list --set prints exactly what it used to: only the file's own keys", async () => {
    // The compatibility half of the owner's decision: the old output is still
    // reachable, byte for byte (no origin column, nothing unset).
    seeded();
    await run(["maxIterations=8"]);
    await run(["model.model=qwen3"]);
    const { code, out, err } = await run(["list", "--set"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toBe('maxIterations = 8\nmodel.model = "qwen3"\n');
    // …and the default form is what changed, so the two cannot be the same code.
    const all = await run(["list"]);
    expect(all.out).not.toBe(out);
  });

  test("list --json carries path, value and origin", async () => {
    seeded();
    const listed = JSON.parse((await run(["list", "--json"])).out) as {
      path: string;
      value: unknown;
      origin: string;
    }[];
    expect(listed.length).toBeGreaterThan(60);
    expect(listed.find((entry) => entry.path === "model.images")).toEqual({
      path: "model.images",
      value: false,
      origin: "default (openai-compatible)",
    });
    // A secret is masked in this form too (never a prefix, never a length).
    await run(["model.apiKey=sk-JSON4"]);
    const withSecret = (await run(["list", "--json"])).out;
    expect(withSecret).not.toContain("sk-JSON4");
  });

  test("a key that already names a profile is ambiguous with --profile", async () => {
    seeded();
    const { code, err } = await run(["set", "profiles.work.model.model", "x", "--profile", "work"]);
    expect(code).toBe(1);
    expect(err).toContain("profile");
  });

  test("$schema cannot be put in a profile", async () => {
    seeded();
    const { code, err } = await run(["set", "$schema", "./x.json", "--profile", "work"]);
    expect(code).toBe(1);
    expect(err).toContain("$schema");
  });

  test("an empty value is the schema's message plus the `unset` hint", async () => {
    seeded();
    const { code, err } = await run(["model.model="]);
    expect(code).toBe(1);
    expect(err).toContain("model.model");
    expect(err).toContain("unset");
  });

  test("Q-D: a section with no value says `get`, not `unset`, and writes nothing", async () => {
    seeded();
    const before = sha(configPath);
    for (const key of ["subagents", "mcpServers", "model"]) {
      // NO_TERMINAL means piped stdin: without the fix, the empty stdin value
      // reaches the typer, and its refusal steers the user to `unset` a section
      // they only wanted to look at.
      const { code, err } = await run([key], { readStdin: async () => "" });
      expect(code).toBe(1);
      expect(err).toContain(`${key} needs a JSON object value`);
      expect(err).toContain(`show it with: tentacle config get ${key}`);
      expect(err).not.toContain("unset");
    }
    expect(sha(configPath)).toBe(before);
  });

  test('Q-D: a leaf given `""` keeps the `unset` hint; a secret leaf keeps the prompt', async () => {
    seeded();
    const leaf = await run(["model.model="]);
    expect(leaf.code).toBe(1);
    expect(leaf.err).toContain("unset");
    expect(leaf.err).not.toContain("config get");
    // A secret LEAF with no value still prompts (hidden), it is not an object.
    const prompts: string[] = [];
    const code = await main(["bun", "cli", "config", "model.apiKey"], {
      out: () => undefined,
      err: () => undefined,
      terminal: { stdin: true, stdout: true },
      readSecret: async (prompt) => {
        prompts.push(prompt);
        return "sk-qd\n";
      },
    });
    expect(code).toBe(0);
    expect(prompts).toEqual(["model.apiKey: "]);
  });

  test("a shorthand value keeps its own `=` (split at the first)", async () => {
    seeded();
    const { code } = await run(["model.baseURL=http://localhost:8080/v1?x=1"]);
    expect(code).toBe(0);
    expect(readFileSync(configPath, "utf8")).toContain("http://localhost:8080/v1?x=1");
  });

  test("unset removes a leaf; a whole section needs --yes without a terminal", async () => {
    seeded();
    await run(["subagents.maxParallel=3"]);
    const removed = await run(["unset", "subagents.maxParallel"]);
    expect(removed.code).toBe(0);
    expect(removed.out).toContain("unset subagents.maxParallel");
    expect(readFileSync(configPath, "utf8")).not.toContain("maxParallel");
    // A section is destructive: refused without a terminal unless --yes.
    const refused = await run(["unset", "model"]);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("--yes");
    const yes = await run(["unset", "model", "--yes"]);
    expect(yes.code).toBe(0);
  });

  test("--unset <key> is the same as `unset <key>`", async () => {
    seeded();
    await run(["autoWake=true"]);
    const { code } = await run(["--unset", "autoWake"]);
    expect(code).toBe(0);
    expect(readFileSync(configPath, "utf8")).not.toContain("autoWake");
  });

  test("no arguments is an error naming the forms", async () => {
    const { code, err } = await run([]);
    expect(code).toBe(1);
    expect(err).toContain("tentacle config set");
    expect(err).toContain("usage:");
  });

  test("a sentence after `config` gets the way back to a prompt", async () => {
    const { code, err } = await run(["how", "do", "I", "set", "a", "key"]);
    expect(code).toBe(1);
    expect(err).toContain("tentacle -- config how do I set a key");
  });
});

describe("Q-A: a prompt that starts with `config` keeps a way back to the prompt", () => {
  test("`tentacle config my nginx` says how to send it as a prompt", async () => {
    // The first word after `config` has no `.`/`=` and is not a top-level key, so
    // it cannot be a key path: the old build sent the whole thing to the model.
    const { code, err } = await run(["my", "nginx"]);
    expect(code).toBe(1);
    expect(err).toContain('unknown config key "my"');
    expect(err).toContain("to send this as a prompt, use: tentacle -- config my nginx");
  });

  test("a real key path or a `key=value` gets NO prompt hint", async () => {
    seeded();
    // A key path that does not resolve is a near miss, not a sentence.
    const typo = await run(["model.foo=x"]);
    expect(typo.err).toContain("unknown config key");
    expect(typo.err).not.toContain("as a prompt");
    // A command word (`get`, `list`, …) is never a prompt.
    expect((await run(["list"])).err).not.toContain("as a prompt");
  });

  test("the hint carries the words as typed, flags aside", async () => {
    const { err } = await run(["how", "are", "you", "--json"]);
    expect(err).toContain("tentacle -- config how are you");
  });
});

describe("LOW-7: Ctrl+C / EOF at the hidden prompt cancels, and writes nothing", () => {
  test("an interrupted prompt is a cancellation: exit 130, 'cancelled', no write", async () => {
    seeded();
    const before = sha(configPath);
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["bun", "cli", "config", "model.apiKey"], {
      out: (text) => out.push(text),
      err: (text) => err.push(text),
      terminal: { stdin: true, stdout: true },
      // `readHiddenLine` resolves `undefined` on SIGINT / EOF (see its own test).
      readSecret: async () => undefined as unknown as string,
    });
    expect(code).toBe(130);
    expect(err.join("")).toContain("cancelled");
    expect(out.join("")).toBe("");
    expect(sha(configPath)).toBe(before);
  });
});
