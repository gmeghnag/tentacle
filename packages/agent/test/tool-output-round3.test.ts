/** Round 3 of fix/tool-output-location: cwd `/` and the three Q1 pins (docs/fix/tool-output-location.md). */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createToolOutputStore } from "../src/tool-output.ts";

const dirs: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "tool-output-r3-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe("a cwd of `/` contains no root (a --no-mount pod, WORKDIR /)", () => {
  test("the spill is saved under the normal root, not lost", async () => {
    // Mutation: drop the `/` rule in `lies` → both roots "lie inside /" → null.
    const root = temp();
    const p = await createToolOutputStore(root, () => join(temp(), "alt"))
      .forProject("/")
      .write("s", "t", "1", "x");
    expect(p?.startsWith(`${root}/`)).toBe(true);
  });

  test("with a null alternative too", async () => {
    const root = temp();
    const p = await createToolOutputStore(root).forProject("/").write("s", "t", "1", "x");
    expect(p?.startsWith(`${root}/`)).toBe(true);
  });
});

describe("Q1 pins", () => {
  test("(a) an alternative that is ALSO inside the cwd is refused: null, nothing in the project", async () => {
    // Mutation: drop `!lies(other, cwd)` → the spill lands in the project.
    const project = temp();
    const root = join(project, "cache");
    const alt = join(project, "alt");
    mkdirSync(root, { recursive: true });
    const p = await createToolOutputStore(root, () => alt)
      .forProject(project)
      .write("s", "t", "1", "x");
    expect(p).toBeNull();
    expect(existsSync(alt)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  test("(b) the alternative root is swept (aged files go, young ones stay)", async () => {
    // Mutation: `roots()` without the alternative → the aged file stays.
    const project = temp();
    const root = join(project, "cache");
    mkdirSync(root, { recursive: true });
    const alt = join(temp(), "alt");
    const store = createToolOutputStore(root, () => alt);
    const sink = store.forProject(project);
    const old = await sink.write("s-old", "t", "1", "x");
    const young = await sink.write("s-young", "t", "1", "x");
    expect(old?.startsWith(`${alt}/`)).toBe(true);
    const now = Date.now();
    const aged = new Date(now - 40 * 86_400_000);
    utimesSync(old ?? "", aged, aged);
    await store.sweep(30, now);
    expect(existsSync(old ?? "")).toBe(false);
    expect(existsSync(young ?? "")).toBe(true);
  });
});
