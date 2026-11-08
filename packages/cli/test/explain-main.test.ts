import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/index.ts";

/** Piped stdin and stdout, whatever terminal runs the suite (CliIO.terminal). */
const NO_TERMINAL = { stdin: false, stdout: false };

let dir: string;
let configDir: string;
const savedConfigDir = process.env.TENTACLE_CONFIG_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tentacle-explain-"));
  configDir = join(dir, "cfg");
  mkdirSync(configDir, { recursive: true });
  // A deliberately BROKEN config: `explain` must never read it.
  writeFileSync(join(configDir, "config.jsonc"), '{ "model": { "provider": }\n');
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

async function run(args: string[]): Promise<Run> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await main(["bun", "cli", "explain", ...args], {
    out: (text) => out.push(text),
    err: (text) => err.push(text),
    terminal: NO_TERMINAL,
  });
  return { code, out: out.join(""), err: err.join("") };
}

describe("tentacle explain", () => {
  test("no argument lists the top-level keys on STDOUT, exit 0", async () => {
    const { code, out, err } = await run([]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("model");
    expect(out).toContain("sub-keys");
    // Never a section's children at the top level.
    expect(out).not.toContain("model.provider");
  });

  test("a section lists its direct children, and works with a BROKEN config file", async () => {
    // The file above does not parse. A command that read it would exit 1 with
    // a `[config error]`; `explain` is static and does not (eval Q8 = (a)).
    const { code, out, err } = await run(["subagents"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    expect(out).toContain("subagents.maxParallel");
    expect(out).not.toContain("config error");
  });

  test("a leaf prints its card", async () => {
    const { code, out } = await run(["subagents.maxParallel"]);
    expect(code).toBe(0);
    expect(out).toContain("At most this many sub-agents");
    expect(out).toContain("TENTACLE_SUBAGENT_MAX_PARALLEL");
    expect(out).toContain("default");
  });

  test("a typo is an error on STDERR with suggestions, exit 1, nothing on STDOUT", async () => {
    const { code, out, err } = await run(["modle"]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("modle");
    expect(err).toContain("model");
    expect(err.startsWith("[error]")).toBe(true);
  });

  test("--all is the flat leaf list on STDOUT", async () => {
    const { code, out, err } = await run(["--all"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    const rows = out.trimEnd().split("\n");
    // Flat, sorted, one canonical path per line — no profiles mirror.
    expect(rows).toEqual([...rows].sort());
    expect(rows).toContain("tools.maxParallel");
    expect(rows.every((row) => !row.startsWith("profiles."))).toBe(true);
    expect(rows.length).toBeGreaterThan(20);
  });

  test("--json prints the same answer as JSON", async () => {
    const { code, out, err } = await run(["subagents.maxParallel", "--json"]);
    expect(code).toBe(0);
    expect(err).toBe("");
    const parsed = JSON.parse(out) as { level: string; entries: { path: string }[] };
    expect(parsed.level).toBe("leaf");
    expect(parsed.entries[0]?.path).toBe("subagents.maxParallel");
  });

  test("--json with a typo still exits 1 and keeps STDOUT empty-ish", async () => {
    const { code, err } = await run(["modle", "--json"]);
    expect(code).toBe(1);
    expect(err).toContain("modle");
  });

  test("--all with a key is refused", async () => {
    const { code, out, err } = await run(["model", "--all"]);
    expect(code).toBe(1);
    expect(out).toBe("");
    expect(err).toContain("--all");
  });

  test("an unknown flag is still an argument error", async () => {
    const { code, err } = await run(["--nope"]);
    expect(code).toBe(1);
    expect(err).toContain("unknown option --nope");
    expect(err).toContain("usage:");
  });

  test("two positionals are refused", async () => {
    const { code, err } = await run(["model", "tools"]);
    expect(code).toBe(1);
    expect(err).toContain("usage:");
  });

  test("it is listed in --help", async () => {
    const out: string[] = [];
    const code = await main(["bun", "cli", "--help"], {
      out: (t) => out.push(t),
      terminal: NO_TERMINAL,
    });
    expect(code).toBe(0);
    expect(out.join("")).toContain("tentacle explain");
  });
});
