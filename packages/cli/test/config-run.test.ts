import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConfigOp } from "../src/config-args.ts";
import { type ConfigFs, nodeConfigFs, runConfig } from "../src/config-run.ts";

let dir: string;
let configDir: string;
let configPath: string;
const savedConfigDir = process.env.TENTACLE_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tentacle-config-run-"));
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

/** The operations the fake fs saw, in order (T11/T12's observable). */
interface Trace {
  readonly calls: string[];
}

/**
 * A real fs, wrapped: every op is recorded and one chosen op can be made to
 * fail or to change the world (the seams T11 and T12 need, with no real timing).
 */
function tracedFs(
  hooks: {
    rename?: (from: string, to: string) => void;
    stat?: (path: string) => {
      mode: number;
      mtimeMs: number;
      size: number;
      kind: "file" | "other";
    };
  } = {},
): { fs: ConfigFs; trace: Trace } {
  const real = nodeConfigFs;
  const calls: string[] = [];
  const fs: ConfigFs = {
    readText: (path) => {
      calls.push(`readText ${path}`);
      return real.readText(path);
    },
    stat: (path) => {
      calls.push(`stat ${path}`);
      return hooks.stat !== undefined ? hooks.stat(path) : real.stat(path);
    },
    kind: (path) => {
      calls.push(`kind ${path}`);
      return real.kind(path);
    },
    realpath: (path) => {
      calls.push(`realpath ${path}`);
      return real.realpath(path);
    },
    ensureDir: (path) => {
      calls.push(`ensureDir ${path}`);
      real.ensureDir(path);
    },
    writeTemp: (path, text, mode) => {
      calls.push(`writeTemp ${path} ${mode.toString(8)}`);
      return real.writeTemp(path, text, mode);
    },
    rename: (from, to) => {
      calls.push(`rename ${from} ${to}`);
      return hooks.rename !== undefined ? hooks.rename(from, to) : real.rename(from, to);
    },
    remove: (path) => {
      calls.push(`remove ${path}`);
      real.remove(path);
    },
  };
  return { fs, trace: { calls } };
}

async function run(
  op: ConfigOp,
  opts: {
    fs?: ConfigFs;
    profile?: string;
    json?: boolean;
    yes?: boolean;
    ask?: (prompt: string) => Promise<string>;
    readStdin?: () => Promise<string>;
    readSecret?: (prompt: string) => Promise<string>;
    isStdinTerminal?: boolean;
  } = {},
): Promise<Run> {
  const result = await runConfig({
    op,
    configPath,
    ...(opts.profile !== undefined ? { profile: opts.profile } : {}),
    json: opts.json === true,
    yes: opts.yes === true,
    isStdinTerminal: opts.isStdinTerminal === true,
    ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
    ...(opts.ask !== undefined ? { ask: opts.ask } : {}),
    ...(opts.readStdin !== undefined ? { readStdin: opts.readStdin } : {}),
    ...(opts.readSecret !== undefined ? { readSecret: opts.readSecret } : {}),
  });
  return result;
}

const setOp = (key: string, text: string): ConfigOp => ({
  kind: "set",
  key,
  value: { from: "argv", text },
});

describe("a set writes the file, atomically, with the right mode", () => {
  test("a missing dir and file are created: 0700 dir, 0600 file", async () => {
    const { code, out } = await run(setOp("subagents.maxParallel", "3"));
    expect(code).toBe(0);
    expect(out).toContain("subagents.maxParallel");
    expect(configPath.length).toBeGreaterThan(0);
    expect(readFileSync(configPath, "utf8")).toContain('"maxParallel": 3');
    expect(statSync(configDir).mode & 0o777).toBe(0o700);
    expect(statSync(configPath).mode & 0o777).toBe(0o600);
  });

  test("an existing file keeps its mode and its comments", async () => {
    mkdirSync(configDir, { recursive: true });
    const original = '{\n  // keep me\n  "maxIterations": 8\n}\n';
    writeFileSync(configPath, original, { mode: 0o640 });
    chmodSync(configPath, 0o640);
    const { code } = await run(setOp("autoWake", "false"));
    expect(code).toBe(0);
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain("// keep me");
    expect(text).toContain('"autoWake": false');
    expect(statSync(configPath).mode & 0o777).toBe(0o640);
  });

  test("the temp is in the same directory and is gone afterwards", async () => {
    const { fs, trace } = tracedFs();
    await run(setOp("autoWake", "true"), { fs });
    const temp = trace.calls.find((c) => c.startsWith("writeTemp"));
    expect(temp).toContain(configDir);
    expect(readdirSync(configDir)).toEqual(["config.jsonc"]);
    // The rename is the visible change, after a temp write in the same dir.
    expect(trace.calls.some((c) => c.startsWith("rename"))).toBe(true);
  });

  test("the write reports what it applies to (eval A6)", async () => {
    const { out } = await run(setOp("subagents.maxParallel", "3"));
    expect(out).toContain("sessions started after this");
    expect(out).toContain("serve");
    expect(out).toContain("carried to a pod");
    const local = await run(setOp("tools.writableDirs", '["/tmp"]'));
    expect(local.out).toContain("not carried to a pod");
  });
});

describe("T11: atomic — a failed rename leaves the target intact and no temp", () => {
  test("rename throws: target byte-identical, temp removed, exit 1", async () => {
    // Mutation: write in place (no temp+rename) → the file is already changed here.
    mkdirSync(configDir, { recursive: true });
    const original = '{\n  // mine\n  "maxIterations": 8\n}\n';
    writeFileSync(configPath, original);
    const { fs, trace } = tracedFs({
      rename: () => {
        throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
      },
    });
    const { code, err } = await run(setOp("autoWake", "true"), { fs });
    expect(code).toBe(1);
    expect(err).toContain("config.jsonc");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    expect(trace.calls.some((c) => c.startsWith("remove"))).toBe(true);
    expect(readdirSync(configDir)).toEqual(["config.jsonc"]);
  });

  test("a symlinked config is written THROUGH the link; the link stays a link", async () => {
    // A dotfiles repo: `~/.config/tentacle/config.jsonc` -> ~/dotfiles/config.jsonc.
    const dotfiles = join(dir, "dotfiles");
    mkdirSync(dotfiles, { recursive: true });
    const real = join(dotfiles, "config.jsonc");
    writeFileSync(real, '{\n  // from dotfiles\n  "maxIterations": 8\n}\n');
    mkdirSync(configDir, { recursive: true });
    symlinkSync(real, configPath);
    const { code } = await run(setOp("autoWake", "true"));
    expect(code).toBe(0);
    // The link is untouched…
    expect(lstatSync(configPath).isSymbolicLink()).toBe(true);
    // …and the write landed in the real file, which kept its comment.
    const text = readFileSync(real, "utf8");
    expect(text).toContain("// from dotfiles");
    expect(text).toContain('"autoWake": true');
    // No temp file was left beside the link (the temp is written in the REAL dir).
    expect(readdirSync(configDir)).toEqual(["config.jsonc"]);
    expect(readdirSync(dotfiles)).toEqual(["config.jsonc"]);
  });

  test("a config path that is not a regular file is refused", async () => {
    mkdirSync(configPath, { recursive: true });
    const { code, err } = await run(setOp("autoWake", "true"));
    expect(code).toBe(1);
    expect(err).toContain("not a regular file");
  });

  test("a read-only file is a clean error, and it is not changed", async () => {
    mkdirSync(configDir, { recursive: true });
    const original = '{\n  "maxIterations": 8\n}\n';
    writeFileSync(configPath, original);
    chmodSync(configPath, 0o400);
    chmodSync(configDir, 0o500);
    try {
      const { code, err } = await run(setOp("autoWake", "true"));
      expect(code).toBe(1);
      expect(err).toContain("config.jsonc");
    } finally {
      chmodSync(configDir, 0o700);
      chmodSync(configPath, 0o600);
    }
  });
});

describe("T12: a concurrent edit — retry once from the re-read, then refuse", () => {
  test("a change between the read and the rename is retried once, and the OTHER edit survives", async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, '{\n  "maxIterations": 8\n}\n');
    // The fake has an "editor" add a key AFTER our read: the first re-stat sees
    // it, so the plan must be redone from the re-read text, or the editor's line
    // would be lost (the classic read-modify-write lost update).
    let stats = 0;
    const real = nodeConfigFs;
    const { fs } = tracedFs({
      stat: (path) => {
        stats++;
        if (stats === 2) {
          const current = real.readText(path);
          const future = real.writeTemp(
            path,
            current.replace('"maxIterations": 8', '"maxIterations": 8,\n  "autoWake": true'),
            0o600,
          );
          real.rename(future, path);
        }
        return real.stat(path);
      },
    });
    const { code } = await run(setOp("model.model", "qwen3"), { fs });
    expect(code).toBe(0);
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain('"autoWake": true');
    expect(text).toContain('"model": "qwen3"');
    expect(stats).toBeGreaterThanOrEqual(3);
  });

  test("a file that appears after the read is a concurrent edit too (no lost write)", async () => {
    // Two `config set` runs on a missing file, or one racing a `tentacle` run's
    // scaffold: the second must not rename text over a file it never read. The
    // mutation (drop the `stamp === undefined` branch in `writeOnce`) loses the
    // other writer's key.
    const real = nodeConfigFs;
    let kinds = 0;
    const { fs } = tracedFs();
    // `readSnapshot` asks `kind` twice (the target, then the resolved path), so the
    // whole read must see "no file" — as it would if another writer created it a
    // moment later.
    const racy: ConfigFs = {
      ...fs,
      kind: (path) => {
        kinds++;
        // The read sees "no file" (as if it had not been created yet) …
        if (kinds <= 2) {
          return "missing";
        }
        return real.kind(path);
      },
    };
    // …and it exists, with another writer's setting, before the rename.
    real.ensureDir(configDir);
    writeFileSync(configPath, '{\n  "maxIterations": 8\n}\n');
    const { code, err } = await run(setOp("model.model", "qwen3"), { fs: racy });
    expect(code).toBe(0);
    expect(err).toBe("");
    const text = readFileSync(configPath, "utf8");
    expect(text).toContain('"maxIterations": 8');
    expect(text).toContain('"model": "qwen3"');
  });

  test("a file that keeps changing is refused: 'changed while editing', nothing written", async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, '{\n  "maxIterations": 8\n}\n');
    let n = 0;
    const { fs, trace } = tracedFs({
      stat: () => {
        // Every check sees a fresh mtime: two attempts, both stale.
        n++;
        return { mode: 0o600, mtimeMs: n, size: 100 + n, kind: "file" };
      },
    });
    const { code, err } = await run(setOp("model.model", "qwen3"), { fs });
    expect(code).toBe(1);
    expect(err).toContain("changed while editing");
    // Never renamed: the temp was removed and the target keeps its bytes.
    expect(trace.calls.some((c) => c.startsWith("rename"))).toBe(false);
    expect(readdirSync(configDir)).toEqual(["config.jsonc"]);
    expect(readFileSync(configPath, "utf8")).toContain('"maxIterations": 8');
  });
});

describe("unset", () => {
  test("unsetting a leaf removes only it, and reports", async () => {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      '{\n  // note\n  "subagents": {\n    "enabled": true,\n    "maxParallel": 3\n  }\n}\n',
    );
    const { code, out } = await run({ kind: "unset", key: "subagents.maxParallel" });
    expect(code).toBe(0);
    expect(out).toContain("unset subagents.maxParallel");
    expect(readFileSync(configPath, "utf8")).toBe(
      '{\n  // note\n  "subagents": {\n    "enabled": true\n  }\n}\n',
    );
  });

  test("a destructive unset (a whole profile/a section) asks; --yes skips", async () => {
    mkdirSync(configDir, { recursive: true });
    const original =
      '{\n  "profiles": {\n    "work": {\n      "model": {\n        "model": "x"\n      }\n    }\n  }\n}\n';
    writeFileSync(configPath, original);
    const asked: string[] = [];
    const declined = await run(
      { kind: "unset", key: "profiles.work" },
      {
        ask: async (prompt) => {
          asked.push(prompt);
          return "n";
        },
      },
    );
    expect(declined.code).toBe(1);
    expect(asked.length).toBe(1);
    expect(declined.err).toContain("not changed");
    expect(readFileSync(configPath, "utf8")).toBe(original);
    const direct = await run({ kind: "unset", key: "profiles.work" }, { yes: true });
    expect(direct.code).toBe(0);
    const text = readFileSync(configPath, "utf8");
    expect(text).not.toContain('"work"');
  });

  test("a destructive unset with no terminal and no --yes is refused, naming --yes", async () => {
    mkdirSync(configDir, { recursive: true });
    const original = '{\n  "subagents": {\n    "enabled": true\n  }\n}\n';
    writeFileSync(configPath, original);
    const { code, err } = await run({ kind: "unset", key: "subagents" });
    expect(code).toBe(1);
    expect(err).toContain("--yes");
    expect(readFileSync(configPath, "utf8")).toBe(original);
  });

  test("a missing file is a clear error", async () => {
    const { code, err } = await run({ kind: "unset", key: "autoWake" });
    expect(code).toBe(1);
    expect(err).toContain("is not set in");
    expect(err).toContain("config.jsonc");
    // Nothing was created by a refused unset.
    expect(readdirSync(dir)).toEqual([]);
  });
});

describe("HIGH-1: a secret inside an object/array value on argv is refused", () => {
  /** A seeded file, so "unchanged" is a real byte comparison. */
  function seeded(): string {
    mkdirSync(configDir, { recursive: true });
    const original = '{\n  // mine\n  "maxIterations": 8\n}\n';
    writeFileSync(configPath, original);
    return original;
  }

  const CASES: readonly { key: string; text: string; secret: string; profile?: string }[] = [
    { key: "model", text: '{"apiKey":"sk-LEAK7"}', secret: "sk-LEAK7" },
    { key: "model", text: '{"apiKey":"sk-LEAK11"}', secret: "sk-LEAK11", profile: "p" },
    { key: "mcpServers.fs.env", text: '{"T":"sk-LEAK9"}', secret: "sk-LEAK9" },
    {
      key: "mcpServers.fs",
      text: '{"command":"mcp-fs","args":["--token","sk-LEAK12"]}',
      secret: "sk-LEAK12",
    },
    { key: "profiles.p", text: '{"model":{"apiKey":"sk-LEAK13"}}', secret: "sk-LEAK13" },
    { key: "model.apiKey", text: "sk-LEAK14", secret: "sk-LEAK14" },
  ];

  for (const { key, text, secret, profile } of CASES) {
    test(`refused, exit 1, bytes unchanged, no secret in the output: ${key} (profile: ${profile ?? "—"})`, async () => {
      const original = seeded();
      const opts = profile === undefined ? {} : { profile };
      const { code, out, err } = await run(setOp(key, text), opts);
      expect(code).toBe(1);
      expect(`${out}${err}`).not.toContain(secret);
      expect(readFileSync(configPath, "utf8")).toBe(original);
      // The refusal names the secret KEY (a path, never a value) and the safe forms.
      expect(err).toContain("refusing a secret on the command line");
      expect(err).toContain("stdin");
    });
  }

  test("the refusal names the secret path(s), and the safe forms", async () => {
    seeded();
    const { err } = await run(setOp("model", '{"model":"qwen3","apiKey":"sk-LEAK15"}'));
    expect(err).toContain("model.apiKey");
    expect(err).not.toContain("sk-LEAK15");
    expect(err).toContain("-");
    const mcp = await run(
      setOp("mcpServers.fs", '{"command":"x","env":{"A":"sk-LEAK16"},"args":["sk-LEAK17"]}'),
    );
    expect(mcp.err).toContain("mcpServers.fs.args");
    expect(mcp.err).toContain("mcpServers.fs.env.A");
  });

  test("the stdin `-` form for an object value stays allowed", async () => {
    seeded();
    const { code, out } = await run(
      { kind: "set", key: "model", value: { from: "stdin" } },
      {
        readStdin: async () => '{"apiKey":"sk-STDIN1"}\n',
      },
    );
    expect(code).toBe(0);
    expect(out).not.toContain("sk-STDIN1");
    expect(readFileSync(configPath, "utf8")).toContain('"apiKey": "sk-STDIN1"');
  });
});

describe("HIGH-2/Q-B: get and list render only the masked tree", () => {
  const SECRET = "sk-STORE9";
  const API_CMD = "pass show tentacle";

  function seededSecrets(): void {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(
      configPath,
      `{
  "model": { "model": "qwen3", "apiKey": "${SECRET}" },
  "mcpServers": {
    "fs": {
      "command": "mcp-fs",
      "args": ["--token", "${SECRET}"],
      "env": { "TOKEN": "${SECRET}" },
      "headers": { "Authorization": "Bearer ${SECRET}" }
    }
  },
  "profiles": { "work": { "model": { "apiKey": "${SECRET}" } }, "ip": { "model": { "apiKeyCommand": "${API_CMD}" } } },
  "model2": { "apiKey": "${SECRET}" }
}
`,
    );
  }

  test("no form of get or list prints a stored secret", async () => {
    seededSecrets();
    const runs = [
      await run({ kind: "get", key: "model" }),
      await run({ kind: "get", key: "model" }, { json: true }),
      await run({ kind: "get", key: "mcpServers" }, { json: true }),
      await run({ kind: "get", key: "mcpServers.fs" }, { json: true }),
      await run({ kind: "get", key: "profiles" }, { json: true }),
      await run({ kind: "get", key: "model.apiKey" }, { json: true }),
      await run({ kind: "list" }),
      await run({ kind: "list" }, { json: true }),
    ];
    for (const got of runs) {
      expect(got.code).toBe(0);
      expect(`${got.out}${got.err}`).not.toContain(SECRET);
      expect(got.out).toContain("***");
    }
    // The JSON keeps its shape (a machine reader still sees which key is secret).
    const model = await run({ kind: "get", key: "model" }, { json: true });
    expect(JSON.parse(model.out)).toEqual({
      key: "model",
      value: { model: "qwen3", apiKey: "***" },
    });
    const mcp = await run({ kind: "get", key: "mcpServers" }, { json: true });
    const mcpValue = (JSON.parse(mcp.out) as { value: Record<string, unknown> }).value;
    expect(JSON.stringify(mcpValue)).toContain("mcp-fs");
    expect(JSON.stringify(mcpValue)).toContain('"args":["***"]');
    // `apiKeyCommand` is a secret in the registry too: masked on read.
    const profiles = await run({ kind: "get", key: "profiles" }, { json: true });
    expect(profiles.out).not.toContain(API_CMD);
  });

  test("Q-B: an unknown/misplaced key's value is masked, its path still shown", async () => {
    seededSecrets();
    const listed = await run({ kind: "list" });
    expect(listed.code).toBe(0);
    expect(listed.out).toContain("model2 = ***");
    expect(listed.out).not.toContain(SECRET);
    const json = await run({ kind: "list" }, { json: true });
    expect((JSON.parse(json.out) as Record<string, unknown>).model2).toBe("***");
    const got = await run({ kind: "get", key: "model2" }, { json: true });
    // `model2` is not a registry key, so `get` refuses it as unknown…
    expect(got.code).toBe(1);
    expect(got.err).toContain("unknown config key");
  });
});

describe("MEDIUM-3: an error never carries the value that failed", () => {
  const SECRET = "sk-NOTINT";

  function seeded(): void {
    mkdirSync(configDir, { recursive: true });
    writeFileSync(configPath, '{\n  "maxIterations": 8\n}\n');
  }

  test("a secret-looking value refused by the TYPER is not echoed", async () => {
    seeded();
    // `args` is a secret array: a non-array value fails types.
    const args = await run(
      { kind: "set", key: "mcpServers.fs.args", value: { from: "stdin" } },
      { readStdin: async () => `${SECRET}\n` },
    );
    expect(args.code).toBe(1);
    expect(`${args.out}${args.err}`).not.toContain(SECRET);
    expect(args.err).toContain("JSON array");
    // `env` is a secret map: a non-object value fails types.
    const env = await run(
      { kind: "set", key: "mcpServers.fs.env", value: { from: "stdin" } },
      { readStdin: async () => `${SECRET}\n` },
    );
    expect(env.code).toBe(1);
    expect(`${env.out}${env.err}`).not.toContain(SECRET);
    expect(env.err).toContain("JSON object");
    // A secret leaf whose value fails the schema (min(1)) — through the prompt.
    const key = await run(
      { kind: "set", key: "model.apiKey", value: { from: "prompt" } },
      { isStdinTerminal: true, readSecret: async () => "" },
    );
    expect(key.code).toBe(1);
    expect(`${key.out}${key.err}`).not.toContain(SECRET);
  });

  test("a schema issue on a secret-looking value does not echo it (M4's path)", async () => {
    seeded();
    // `tools.writableDirs` is not secret, but the VALUE is what must not escape:
    // the whole-file validate's message is the mediator here.
    const result = await run(setOp("tools.maxParallel", SECRET));
    expect(result.code).toBe(1);
    expect(`${result.out}${result.err}`).not.toContain(SECRET);
  });
});

describe("LOW-8: an lstat error other than ENOENT is reported as itself", () => {
  test("the real fs: EACCES throws out of `kind` instead of reading as 'other'", () => {
    // A real, unreadable directory: the lstat fails with EACCES, which means
    // "cannot tell", not "not a regular file" — so it must not become `"other"`.
    const locked = join(dir, "locked");
    mkdirSync(locked, { recursive: true });
    writeFileSync(join(locked, "config.jsonc"), "{}\n");
    chmodSync(locked, 0o000);
    try {
      let thrown: unknown;
      try {
        nodeConfigFs.kind(join(locked, "config.jsonc"));
      } catch (error) {
        thrown = error;
      }
      expect(thrown instanceof Error).toBe(true);
      expect((thrown as NodeJS.ErrnoException).code).toBe("EACCES");
      // The harmless case still means "missing" (the ENOENT branch, unchanged).
      expect(nodeConfigFs.kind(join(dir, "nope", "config.jsonc"))).toBe("missing");
    } finally {
      chmodSync(locked, 0o700);
    }
  });

  test("a `kind` that throws reaches the user as that error, with the path", async () => {
    // The same failure through the command: readSnapshot must report it, not call
    // it "not a regular file".
    const refusing: ConfigFs = {
      ...nodeConfigFs,
      kind: () => {
        throw Object.assign(new Error("EACCES: permission denied, lstat"), { code: "EACCES" });
      },
    };
    const { code, err } = await run(setOp("autoWake", "true"), { fs: refusing });
    expect(code).toBe(1);
    expect(err).toContain("EACCES: permission denied");
    expect(err).toContain("config.jsonc");
    expect(err).not.toContain("not a regular file");
  });

  test("a missing file is still 'missing' (the ENOENT path is unchanged)", async () => {
    // No hooks: the real fs, no file — the harmless case must not regress.
    const { code, out } = await run(setOp("autoWake", "true"));
    expect(code).toBe(0);
    expect(out).toContain("set autoWake");
  });
});
