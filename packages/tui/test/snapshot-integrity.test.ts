/**
 * fix/test-stray-snapshot-write: a checked-in `.snap` must keep Bun's header as
 * its FIRST line. Twice a stray write from an unrelated test landed there —
 * `{"resident":false}` (07729c2b) and an `ESC[?25h` — and each time the symptom
 * was 14 red `T3 frames` cases in someone else's gate, not an obvious leak
 * (docs/fix/test-stray-snapshot-write.md §Context).
 *
 * The writer of the JSON bytes is closed at its source (`runResidentMode`'s
 * `ResidentIO` seam); this guard is what makes any recurrence attributable at
 * once, whatever the bytes are.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const SNAPSHOT_DIR = join(import.meta.dir, "__snapshots__");
/** Bun's own header: the first line of every snapshot file it writes. */
const HEADER = "// Bun Snapshot v1, https://bun.sh/docs/test/snapshots";

/**
 * The snapshot files in `dir` whose first line is not Bun's header, with what
 * that first line actually is (so a failure names the stray byte, not just the
 * file). An `ESC[?25h`-overwritten header is caught too: it is not the header.
 */
function straySnapshots(dir: string): { file: string; firstLine: string }[] {
  const strays: { file: string; firstLine: string }[] = [];
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".snap"))) {
    const firstLine = readFileSync(join(dir, file), "utf8").split("\n")[0] ?? "";
    if (firstLine !== HEADER) strays.push({ file, firstLine });
  }
  return strays;
}

describe("fix/test-stray-snapshot-write: the checked-in snapshots are intact", () => {
  test("every file in packages/tui/test/__snapshots__ starts with Bun's header", () => {
    // Both files are read by the suite's own snapshot tests, so an empty dir
    // would make this pass for nothing: assert the guard actually saw them.
    const files = readdirSync(SNAPSHOT_DIR).filter((name) => name.endsWith(".snap"));
    expect(files.length).toBeGreaterThan(0);
    // A stray first line (a value prepended by a leaked write) fails here by
    // name, instead of turning 14 unrelated snapshot cases red.
    expect(straySnapshots(SNAPSHOT_DIR)).toEqual([]);
  });

  test("the checker reports a stray file and only it (non-vacuity)", () => {
    // Mutation: make `straySnapshots` return `[]` unconditionally → the first
    // test above still passes, and this one goes red.
    const dir = join(import.meta.dir, ".tmp-snapshot-guard");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, "good.test.ts.snap"), `${HEADER}\n\nexports[1] = \`"a"\`;\n`);
      writeFileSync(join(dir, "leaked.test.ts.snap"), `{"resident":false}\n${HEADER}\n`);
      expect(straySnapshots(dir)).toEqual([
        { file: "leaked.test.ts.snap", firstLine: '{"resident":false}' },
      ]);
      // A header overwritten rather than prepended (the `ESC[?25h` variant).
      writeFileSync(join(dir, "esc.test.ts.snap"), "\u001b[?25h Snapshot v1, x\n");
      expect(straySnapshots(dir).map((s) => s.file)).toEqual([
        "esc.test.ts.snap",
        "leaked.test.ts.snap",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the only direct stdout write in pod-resident.ts is the default seam", () => {
    // The class fix: a resident mode's data line goes through `ResidentIO`, so
    // `main`'s `out` sink is honoured and no test can leak onto fd 1 again.
    // Mutation: put a `process.stdout.write(...)` back in `runResidentMode` → red.
    const src = readFileSync(join(import.meta.dir, "../../cli/src/pod-resident.ts"), "utf8");
    const writes = src.split("\n").filter((line) => line.includes("process.stdout.write"));
    // EXACTLY one: `processResidentIO`, the production default. A second one is
    // a mode writing the process's fd again, which is the bug.
    expect(writes).toEqual(["  out: (text) => void process.stdout.write(text),"]);
    // The ONE place that legitimately uses the real stdout: the bridge, whose
    // stdout IS the RPC channel (AGENTS §7). It must keep it.
    expect(src).toContain("stdout: process.stdout");
  });
});
