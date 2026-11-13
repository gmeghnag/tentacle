/**
 * The 9d dispatch seams: `cliMode` knows the two new words, `parseArgs` keeps a
 * REPEATED flag as a list, and `main` routes both commands without loading a
 * model (docs/feat/device-pairing.md 9d).
 *
 * The properties, each naming its mutation:
 * - `cliMode("pair")` / `("devices")` are their own modes (mutation: leave them
 *   out → the word is sent to the MODEL as a prompt, which is what today does);
 * - a repeated `--address` keeps every value (mutation: keep the last → a laptop
 *   with two addresses publishes one);
 * - a non-repeated flag still refuses a repeat (mutation: allow it everywhere →
 *   `--host a --host b` silently means `b`);
 * - `pair`/`devices` never run a key command (mutation: classify them `true` →
 *   a broken `apiKeyCommand` stops a revoke).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ARGS, USAGE, cliMode, modeUsesModel, parseArgs } from "../src/flags.ts";
import { main } from "../src/index.ts";

const NO_TERMINAL = { stdin: false, stdout: false };
/** The var `configDirFromEnv` reads; a COMPUTED key, the only form `noDelete` allows (§6). */
const ENV_KEY = "TENTACLE_CONFIG_DIR";

describe("cliMode", () => {
  test("pair and devices are commands, not prompts (mutation: omit them)", () => {
    expect(cliMode(["pair"])).toBe("pair");
    expect(cliMode(["pair", "--address", "ws://h:1/e2e"])).toBe("pair");
    expect(cliMode(["devices"])).toBe("devices");
    expect(cliMode(["devices", "revoke", "iPhone"])).toBe("devices");
    expect(cliMode(["devices", "reset"])).toBe("devices");
    // Their neighbours stay what they were.
    expect(cliMode(["ps"])).toBe("ps");
    expect(cliMode(["pairing"])).toBe("prompt");
  });

  test("neither runs the user's key commands (mutation: classify them true)", () => {
    expect(modeUsesModel(cliMode(["pair"]))).toBe(false);
    expect(modeUsesModel(cliMode(["devices"]))).toBe(false);
  });

  test("both have a usage line", () => {
    expect(USAGE.pair).toContain("--address");
    expect(USAGE.pair).toContain("--name");
    expect(USAGE.devices).toContain("revoke");
    expect(USAGE.devices).toContain("reset");
  });
});

describe("--address is a list", () => {
  const parse = (args: readonly string[]) => parseArgs(args, ARGS.pair);

  test("every value is kept, in the order given (mutation: keep the last)", () => {
    const parsed = parse(["--address", "ws://a.test/e2e", "--address=ws://b.test/e2e"]);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok ? parsed.repeats?.get("address") : []).toEqual([
      "ws://a.test/e2e",
      "ws://b.test/e2e",
    ]);
    // And it is NOT in `flags`: one value per name there would be a second truth.
    expect(parsed.ok ? parsed.flags.has("address") : true).toBe(false);
  });

  test("one --address is still a list", () => {
    const parsed = parse(["--address", "ws://a.test/e2e"]);
    expect(parsed.ok ? parsed.repeats?.get("address") : []).toEqual(["ws://a.test/e2e"]);
  });

  test("none given is an empty map, not undefined entries", () => {
    const parsed = parse(["--name", "laptop"]);
    expect(parsed.ok ? (parsed.repeats?.get("address") ?? []) : ["x"]).toEqual([]);
    expect(parsed.ok ? parsed.flags.get("name") : "").toBe("laptop");
  });

  test("a NON-repeated flag still refuses a repeat (mutation: allow it everywhere)", () => {
    const parsed = parse(["--name", "a", "--name", "b"]);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? "" : parsed.error).toBe("--name given more than once");
  });

  test("a repeated value flag still needs a value", () => {
    const parsed = parse(["--address"]);
    expect(parsed.ok ? "" : parsed.error).toBe("--address needs a value");
  });

  test("a stray word is refused (pair takes no positionals)", () => {
    const parsed = parse(["phone"]);
    expect(parsed.ok ? "" : parsed.error).toBe('unexpected argument "phone"');
  });
});

describe("devices' words", () => {
  test("the verb and its subject, at most two", () => {
    const parsed = parseArgs(["revoke", "iPhone"], ARGS.devices);
    expect(parsed.ok ? parsed.positional : []).toEqual(["revoke", "iPhone"]);
    expect(parseArgs(["a", "b", "c"], ARGS.devices).ok).toBe(false);
  });

  test("--yes (and -y) is the reset confirmation", () => {
    const parsed = parseArgs(["reset", "--yes"], ARGS.devices);
    expect(parsed.ok ? parsed.bools.has("yes") : false).toBe(true);
    const short = parseArgs(["reset", "-y"], ARGS.devices);
    expect(short.ok ? short.bools.has("yes") : false).toBe(true);
  });
});

describe("main dispatches them before any config load", () => {
  test("`tentacle pair` with no address refuses with the hint, not a prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pair-dispatch-"));
    const saved = process.env[ENV_KEY];
    process.env[ENV_KEY] = dir;
    try {
      const out: string[] = [];
      const err: string[] = [];
      // A config dir with no daemon record: nothing a phone can reach.
      const code = await main(["bun", "cli", "pair"], {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        terminal: NO_TERMINAL,
      });
      expect(code).toBe(1);
      expect(err.join("")).toContain("serve --host 0.0.0.0");
      // A prompt would have tried to answer; nothing reached STDOUT.
      expect(out).toEqual([]);
    } finally {
      if (saved === undefined)
        delete process.env[ENV_KEY]; // computed: `noDelete` allows it (AGENTS §6)
      else process.env[ENV_KEY] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`tentacle devices` on a fresh config dir lists nothing and exits 0", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devices-dispatch-"));
    const saved = process.env[ENV_KEY];
    process.env[ENV_KEY] = dir;
    try {
      const out: string[] = [];
      const err: string[] = [];
      const code = await main(["bun", "cli", "devices"], {
        out: (text) => out.push(text),
        err: (text) => err.push(text),
        terminal: NO_TERMINAL,
      });
      expect(code).toBe(0);
      expect(out).toEqual([]);
      expect(err.join("")).toContain("tentacle pair");
    } finally {
      if (saved === undefined)
        delete process.env[ENV_KEY]; // computed: `noDelete` allows it (AGENTS §6)
      else process.env[ENV_KEY] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`tentacle devices revoke` with no word is a usage error, not a prompt", async () => {
    const dir = mkdtempSync(join(tmpdir(), "devices-dispatch-"));
    const saved = process.env[ENV_KEY];
    process.env[ENV_KEY] = dir;
    try {
      const err: string[] = [];
      const code = await main(["bun", "cli", "devices", "revoke"], {
        out: () => {},
        err: (text) => err.push(text),
        terminal: NO_TERMINAL,
      });
      expect(code).toBe(1);
      expect(err.join("")).toContain("missing argument");
    } finally {
      if (saved === undefined)
        delete process.env[ENV_KEY]; // computed: `noDelete` allows it (AGENTS §6)
      else process.env[ENV_KEY] = saved;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
