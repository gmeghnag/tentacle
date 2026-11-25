/**
 * T1 (docs/feat/parallel-unit-tests.md): the `test` script is the STRICT
 * runner. Not "it is parallel" — a mechanism assertion would pass on any
 * runner — but the property the gate stands on: a file that kills its own
 * process is a FAILURE, named, with a non-zero exit.
 *
 * Why it matters: the serial runner (`bun test`) dies inside a file that calls
 * `process.exit(0)` and still exits 0, so today's gate can lose a whole file
 * and its verdict silently. `--parallel` reports
 * `✗ <file> (worker crashed: exit code 0)` and exits 1.
 *
 * The fixtures are `*.fixture.ts`, which Bun's discovery never picks, so the
 * suite does not run them on its own; each case spawns the root `test` script
 * explicitly over them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const FIXTURES = "./scripts/test/fixtures/test-gate";
// The `./` prefix is load-bearing: a name without `.test`/`.spec` is only treated
// as a PATH when it looks like one (Bun otherwise searches it as a name filter).
const fixture = (name: string): string => `${FIXTURES}/${name}.fixture.ts`;

/** The root `package.json`'s `test` script — the gate's own definition. */
function testScript(): string {
  const pkg: unknown = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
  const script = (pkg as { scripts?: Record<string, string> }).scripts?.test;
  if (script === undefined) throw new Error("package.json has no `test` script");
  return script;
}

interface Run {
  readonly code: number;
  readonly out: string;
}

/** Run the root `test` script over `files`, exactly as `bun run test` does. */
async function runGate(files: readonly string[]): Promise<Run> {
  const proc = Bun.spawn(["bun", "run", "test", "--", ...files], {
    cwd: ROOT,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, out: out + err };
}

describe("T1: the test script is the strict runner", () => {
  test("the script exists and is not the bare serial runner", () => {
    expect(testScript()).not.toBe("bun test");
  });

  test("a passing file alone exits 0 (the gate is not simply always red)", async () => {
    const run = await runGate([fixture("passes")]);
    expect(run.code).toBe(0);
    expect(run.out).toContain("passes.fixture.ts");
  }, 60_000);

  test("a failing file and a self-exiting file: both fail, both named, exit non-zero", async () => {
    const run = await runGate([fixture("passes"), fixture("fails"), fixture("exits")]);
    // The serial runner exits 0 here: `exits` takes the process down first, and
    // the failing test after it is never reported. That is the bug this pins.
    expect(run.code).not.toBe(0);
    // Named, with its own failing test — not a swallowed verdict.
    expect(run.out).toContain("fails.fixture.ts");
    expect(run.out).toContain("the failing fixture fails");
    // The crash is a failure of its own, reported as one.
    expect(run.out).toContain("exits.fixture.ts");
    expect(run.out).toContain("worker crashed");
    // Counted: the control passes, the failing file AND the crash are fails.
    expect(run.out).toMatch(/^ *1 pass$/m);
    expect(run.out).toMatch(/^ *2 fail$/m);
  }, 60_000);
});
