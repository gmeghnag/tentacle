/**
 * The `search` TOOL — the I/O half (docs/feat/explore-search.md, Tests T-S3 and
 * T-S5): the capability probe and its cache, the demotion, and the schema's
 * refusals. Driven against a SCRIPTED `ExecutionEnvironment`, so no probe, no
 * engine and no image is needed (AGENTS §9: use injectable seams, not real I/O).
 */
import { describe, expect, test } from "bun:test";
import type { ExecOptions, ExecResult, ExecutionEnvironment, ToolContext } from "@tentacle/core";
import { forgetProbedEngine, searchTool } from "../src/search-tool.ts";
import { MAX_BYTES } from "../src/search.ts";

const PROBE = "TENTACLE_ENGINE";

interface Recorded {
  readonly command: string;
  readonly options?: ExecOptions;
}

/**
 * A scripted env. `respond` decides each call's result, so a test can make the
 * probe fail, make rg break, or make the search return a fixed engine output.
 */
function scriptedEnv(
  respond: (command: string, options?: ExecOptions) => ExecResult | Promise<ExecResult>,
) {
  const calls: Recorded[] = [];
  const env: ExecutionEnvironment = {
    id: "scripted",
    async exec(command, options) {
      calls.push({ command, ...(options !== undefined ? { options } : {}) });
      return respond(command, options);
    },
    async readFile() {
      return "node_modules/\ndist/\n*.log\n";
    },
    async writeFile() {},
  };
  const probes = (): Recorded[] => calls.filter((call) => call.command.includes(PROBE));
  const searches = (): Recorded[] => calls.filter((call) => !call.command.includes(PROBE));
  return { env, calls, probes, searches };
}

function ctxFor(env: ExecutionEnvironment, signal = new AbortController().signal): ToolContext {
  return { sessionId: "s", signal, env };
}

/** The probe's answers, as the real `sh` prints them. */
const probeRg = (binaryFilter = 1): ExecResult => ({
  stdout: `TENTACLE_ENGINE=rg\nTENTACLE_GREP_CAPS=1\nTENTACLE_BINFILTER=${binaryFilter}\n`,
  stderr: "",
  exitCode: 0,
});
const probeGrep = (binaryFilter = 0): ExecResult => ({
  stdout: `TENTACLE_ENGINE=grep\nTENTACLE_GREP_CAPS=1\nTENTACLE_BINFILTER=${binaryFilter}\n`,
  stderr: "",
  exitCode: 0,
});

/** A search that "found" one line, with its status on stderr (as the shell carries it). */
const hit = (): ExecResult => ({
  stdout: "./src/a.ts:3:needleTwo();\n",
  stderr: "TENTACLE_RC=0\n",
  exitCode: 0,
});

describe("T-S3: the probe is once per env, and its answer is cached", () => {
  test("two calls probe ONCE, and the cached engine is reused", async () => {
    const rig = scriptedEnv((command) => (command.includes(PROBE) ? probeRg() : hit()));
    forgetProbedEngine(rig.env);
    const first = await searchTool.execute({ pattern: "needle" }, ctxFor(rig.env));
    const second = await searchTool.execute({ pattern: "needle" }, ctxFor(rig.env));
    expect(rig.probes()).toHaveLength(1);
    expect(rig.searches()).toHaveLength(2);
    expect(first.content).toContain("(engine=rg)");
    expect(second.content).toContain("(engine=rg)");
    expect(first.content).toContain("./src/a.ts:3:needleTwo();");
  });

  test("the probe carries its own timeout and NO ctx.signal (M4)", async () => {
    const rig = scriptedEnv((command) => (command.includes(PROBE) ? probeRg() : hit()));
    forgetProbedEngine(rig.env);
    const controller = new AbortController();
    await searchTool.execute({ pattern: "needle" }, ctxFor(rig.env, controller.signal));
    const probe = rig.probes()[0];
    expect(probe?.options?.signal).toBeUndefined();
    expect(probe?.options?.timeoutMs).toBe(5000);
    // The SEARCH does carry the call's signal (a cancel kills the walk).
    expect(rig.searches()[0]?.options?.signal).toBe(controller.signal);
    expect(rig.searches()[0]?.options?.timeoutMs).toBe(20000);
  });

  test("the pattern and the path are never outside a quoted position", async () => {
    const rig = scriptedEnv((command) => (command.includes(PROBE) ? probeRg() : hit()));
    forgetProbedEngine(rig.env);
    await searchTool.execute({ pattern: "it's $(id)", path: "a b" }, ctxFor(rig.env));
    const command = rig.searches()[0]?.command ?? "";
    expect(command).toContain("-e 'it'\\''s $(id)'");
    expect(command).toContain("-- './a b'");
    // The pattern is never in flag position.
    expect(command).not.toMatch(/-e\s+-/);
  });
});

describe("T-S3(a): a non-definitive probe caches NOTHING (the anti-poison property)", () => {
  test("a probe that times out falls back for THIS call and probes again next time", async () => {
    let probeCount = 0;
    const rig = scriptedEnv((command) => {
      if (command.includes(PROBE)) {
        probeCount += 1;
        return { stdout: "", stderr: "killed", exitCode: 124 };
      }
      return hit();
    });
    forgetProbedEngine(rig.env);
    const first = await searchTool.execute({ pattern: "needle" }, ctxFor(rig.env));
    expect(first.content).toContain("(engine=grep)");
    const second = await searchTool.execute({ pattern: "needle" }, ctxFor(rig.env));
    expect(second.content).toContain("(engine=grep)");
    // NOT cached: the second call probed again.
    expect(probeCount).toBe(2);
  });

  test("a rejected probe (a throw) also caches nothing", async () => {
    let probeCount = 0;
    const rig = scriptedEnv((command) => {
      if (command.includes(PROBE)) {
        probeCount += 1;
        throw new Error("exec exploded");
      }
      return hit();
    });
    forgetProbedEngine(rig.env);
    // The registry would catch this; the tool's own contract is the same.
    await expect(searchTool.execute({ pattern: "needle" }, ctxFor(rig.env))).rejects.toThrow();
    await expect(searchTool.execute({ pattern: "needle" }, ctxFor(rig.env))).rejects.toThrow();
    expect(probeCount).toBe(2);
  });

  test("unparseable probe output caches nothing either", async () => {
    let probeCount = 0;
    const rig = scriptedEnv((command) => {
      if (command.includes(PROBE)) {
        probeCount += 1;
        return { stdout: "who knows", stderr: "", exitCode: 0 };
      }
      return hit();
    });
    forgetProbedEngine(rig.env);
    await searchTool.execute({ pattern: "needle" }, ctxFor(rig.env));
    await searchTool.execute({ pattern: "needle" }, ctxFor(rig.env));
    expect(probeCount).toBe(2);
  });
});

describe("T-S3(b): a broken rg is demoted, retried ONCE, and the cache pins grep (F14/M4)", () => {
  test("one retry, the note names the failure, and the next call never runs rg again", async () => {
    const rig = scriptedEnv((command) => {
      if (command.includes(PROBE)) {
        return probeRg();
      }
      if (command.includes("rg ")) {
        // Engine-shaped failure: `rg:` on stderr, rc 2, NOT a regex error.
        return {
          stdout: "",
          stderr: "rg: error loading config file\nTENTACLE_RC=2\n",
          exitCode: 0,
        };
      }
      return hit();
    });
    forgetProbedEngine(rig.env);
    const first = await searchTool.execute({ pattern: "needle" }, ctxFor(rig.env));
    expect(first.content).toContain("(engine=grep)");
    expect(first.content).toContain("[note: ripgrep failed (rg: error loading config file)");
    expect(first.content).toContain("./src/a.ts:3:needleTwo();");
    // ONE rg run, ONE fallback run — never a loop.
    expect(rig.searches().filter((call) => call.command.includes("rg "))).toHaveLength(1);
    expect(rig.searches().filter((call) => !call.command.includes("rg "))).toHaveLength(1);
    // Demoted: the NEXT call issues no probe and no rg run.
    const before = rig.calls.length;
    const second = await searchTool.execute({ pattern: "needle" }, ctxFor(rig.env));
    expect(second.content).toContain("(engine=grep)");
    expect(rig.probes()).toHaveLength(1);
    expect(rig.calls.slice(before).some((call) => call.command.includes("rg "))).toBe(false);
  });

  test("a PARSE error is never retried (H2): one run, an error, retry advice", async () => {
    let searches = 0;
    const rig = scriptedEnv((command) => {
      if (command.includes(PROBE)) {
        return probeRg();
      }
      searches += 1;
      return { stdout: "", stderr: "rg: regex parse error:\nTENTACLE_RC=2\n", exitCode: 0 };
    });
    forgetProbedEngine(rig.env);
    const result = await searchTool.execute({ pattern: "foo(" }, ctxFor(rig.env));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("fixed_strings: true");
    expect(searches).toBe(1);
  });

  test("a PER-PATH rg failure does NOT demote the cache (M3)", async () => {
    // One unreadable directory is the walk's environment, not rg's dialect:
    // demoting on it pins the POSIX fallback (and its narrower pattern set) for
    // the rest of the session, which the model cannot undo.
    let searches = 0;
    const rig = scriptedEnv((command) => {
      if (command.includes(PROBE)) {
        return probeRg();
      }
      searches += 1;
      if (command.includes("rg ")) {
        return {
          stdout: "./src/a.ts:1:needle\n",
          stderr: "rg: ./locked: Permission denied (os error 13)\nTENTACLE_RC=2\n",
          exitCode: 0,
        };
      }
      return hit();
    });
    forgetProbedEngine(rig.env);
    const first = await searchTool.execute({ pattern: "needle" }, ctxFor(rig.env));
    // No retry, no fallback, and the path problem is REPORTED (M2), not lost.
    expect(first.content).toContain("(engine=rg)");
    expect(first.content).toContain("Permission denied");
    expect(first.content).not.toContain("POSIX fallback");
    // The cache still holds rg: the next call runs rg again and never re-probes.
    const before = rig.searches().length;
    await searchTool.execute({ pattern: "needle" }, ctxFor(rig.env));
    expect(rig.probes()).toHaveLength(1);
    expect(rig.searches().slice(before)[0]?.command).toContain("rg ");
    expect(searches).toBe(2);
  });

  test("the demotion note is stripped and bounded (H2)", async () => {
    // The retry reason is raw rg stderr: a pod controls the image's `rg` and the
    // names it prints, so the line can carry `ESC[2J` and be arbitrarily long.
    const rig = scriptedEnv((command) => {
      if (command.includes(PROBE)) {
        return probeRg();
      }
      if (command.includes("rg ")) {
        return {
          stdout: "",
          stderr: `rg: error loading config file \u001b[2J\u001b[31mFAKE PROMPT> ${"y".repeat(5000)}\nTENTACLE_RC=2\n`,
          exitCode: 0,
        };
      }
      return hit();
    });
    forgetProbedEngine(rig.env);
    const result = await searchTool.execute({ pattern: "needle" }, ctxFor(rig.env));
    expect(result.content).toContain("ripgrep failed");
    expect(result.content).not.toContain("\u001b");
    expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(MAX_BYTES);
  });
});

describe("T-S3(d): the carried status and TENTACLE_MISSING are honoured (H3)", () => {
  test("a missing path is status 3 inside stderr, though exec reports 0", async () => {
    const rig = scriptedEnv((command) =>
      command.includes(PROBE)
        ? probeRg()
        : { stdout: "", stderr: "TENTACLE_MISSING\nTENTACLE_RC=3\n", exitCode: 0 },
    );
    forgetProbedEngine(rig.env);
    const result = await searchTool.execute({ pattern: "needle", path: "nope" }, ctxFor(rig.env));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("path not found: ./nope");
  });

  test("a killed search (124) reports a timeout, not a partial list (F5/F10)", async () => {
    const rig = scriptedEnv((command) =>
      command.includes(PROBE) ? probeRg() : { stdout: "./a.ts:1:x\n", stderr: "", exitCode: 124 },
    );
    forgetProbedEngine(rig.env);
    const result = await searchTool.execute({ pattern: "x" }, ctxFor(rig.env));
    expect(result.isError).toBe(true);
    expect(result.content).toContain("timed out");
    expect(result.content).not.toContain("[search truncated");
  });
});

describe("T-S3: the fallback never runs when the probe says grep and there is no rg", () => {
  test("a `grep`-engine env runs the POSIX command and never mentions rg", async () => {
    const rig = scriptedEnv((command) => (command.includes(PROBE) ? probeGrep(1) : hit()));
    forgetProbedEngine(rig.env);
    const result = await searchTool.execute({ pattern: "needle" }, ctxFor(rig.env));
    expect(result.content).toContain("(engine=grep)");
    expect(rig.searches()[0]?.command).toContain("find -H");
    expect(rig.searches()[0]?.command).not.toContain("rg ");
    // `-I` is passed only when the probe says it filters (busybox accepts+ignores).
    expect(rig.searches()[0]?.command).toContain("-I");
  });

  test("a busybox-style probe (BINFILTER=0) does NOT pass -I", async () => {
    const rig = scriptedEnv((command) => (command.includes(PROBE) ? probeGrep(0) : hit()));
    forgetProbedEngine(rig.env);
    await searchTool.execute({ pattern: "needle" }, ctxFor(rig.env));
    expect(rig.searches()[0]?.command).not.toContain("-I");
  });
});

describe("T-S5: the schema refuses what it says it refuses", () => {
  function refusal(raw: unknown): string {
    const parsed = searchTool.inputSchema.safeParse(raw);
    return parsed.success ? "" : parsed.error.message;
  }

  test("a newline / CR / NUL pattern is refused (F8)", () => {
    expect(refusal({ pattern: "a\nb" })).not.toBe("");
    expect(refusal({ pattern: "a\rb" })).not.toBe("");
    expect(refusal({ pattern: "a\u0000b" })).not.toBe("");
  });

  test("an empty pattern in content mode is refused (F12)", () => {
    expect(refusal({ pattern: "" })).toContain("pattern");
    expect(refusal({})).toContain("pattern");
  });

  test("`files` with NEITHER pattern nor glob is refused (F12)", () => {
    expect(refusal({ output_mode: "files" })).toContain("glob");
  });

  test("a glob with a slash, `**`, a leading `!` or `..` is refused (H5)", () => {
    for (const glob of ["src/**/a*.ts", "a/b.ts", "!*.ts", "..ts"]) {
      expect(refusal({ glob, output_mode: "files" })).not.toBe("");
    }
    // A plain basename glob with no `/` is accepted.
    expect(refusal({ glob: "*.ts", output_mode: "files" })).toBe("");
    expect(refusal({ glob: "[[]id[]].ts", output_mode: "files" })).toBe("");
  });

  test("an absolute path and a climbing `..` are refused at the TOOL boundary (Q6 a)", async () => {
    for (const path of ["/etc", "../x"]) {
      const result = await searchTool.execute(
        { pattern: "x", path },
        ctxFor(scriptedEnv(() => hit()).env),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toMatch(/inside the workspace|climbs out/);
    }
  });

  test("max_results beyond the ceiling is clamped, not refused (F11)", async () => {
    const rig = scriptedEnv((command) => (command.includes(PROBE) ? probeRg() : hit()));
    forgetProbedEngine(rig.env);
    const result = await searchTool.execute(
      { pattern: "x", max_results: 10 ** 9 },
      ctxFor(rig.env),
    );
    expect(result.isError).toBe(false);
    // The ceiling is applied in the pure module; the run still happened once.
    expect(rig.searches()).toHaveLength(1);
  });
});
