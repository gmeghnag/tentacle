import { describe, expect, test } from "bun:test";
import type { ExecutionEnvironment, ToolContext } from "@tentacle/core";
import { PathLocks } from "@tentacle/core";
import { fsEditTool, fsMultiEditTool, fsWriteTool } from "../src/index.ts";

/** An env whose read and write each yield, so unlocked read-modify-writes interleave. */
function slowEnv(files: Record<string, string>): ExecutionEnvironment {
  const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 1));
  return {
    id: "slow",
    async exec() {
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async readFile(path) {
      const value = files[path];
      await tick();
      if (value === undefined) {
        throw new Error(`no such file: ${path}`);
      }
      return value;
    },
    async writeFile(path, contents) {
      await tick();
      files[path] = contents;
    },
  };
}

function ctx(env: ExecutionEnvironment, extra: Partial<ToolContext> = {}): ToolContext {
  return { sessionId: "s1", signal: new AbortController().signal, env, ...extra };
}

describe("path locks in the file tools", () => {
  test("two concurrent fs_edit on one path both land (repro D: no lost update)", async () => {
    const files = { "f.txt": "alpha\nbeta\n" };
    const c = ctx(slowEnv(files));
    const [a, b] = await Promise.all([
      fsEditTool.execute({ path: "f.txt", old_string: "alpha", new_string: "ALPHA" }, c),
      fsEditTool.execute({ path: "f.txt", old_string: "beta", new_string: "BETA" }, c),
    ]);
    expect(a.isError).toBeUndefined();
    expect(b.isError).toBeUndefined();
    expect(files["f.txt"]).toBe("ALPHA\nBETA\n");
  });

  test("a clashing second edit fails visibly instead of overwriting", async () => {
    const files = { "f.txt": "alpha\n" };
    const c = ctx(slowEnv(files));
    const [a, b] = await Promise.all([
      fsEditTool.execute({ path: "f.txt", old_string: "alpha", new_string: "one" }, c),
      fsEditTool.execute({ path: "f.txt", old_string: "alpha", new_string: "two" }, c),
    ]);
    expect(a.isError).toBeUndefined();
    expect(b.isError).toBe(true);
    expect(b.content).toContain("old_string not found");
    expect(files["f.txt"]).toBe("one\n");
  });

  test("fs_multi_edit and fs_write serialise with fs_edit on the same path", async () => {
    const files = { "f.txt": "a b c\n" };
    const c = ctx(slowEnv(files));
    await Promise.all([
      fsEditTool.execute({ path: "f.txt", old_string: "a", new_string: "A" }, c),
      fsMultiEditTool.execute({ path: "f.txt", edits: [{ old_string: "b", new_string: "B" }] }, c),
      fsMultiEditTool.execute({ path: "f.txt", edits: [{ old_string: "c", new_string: "C" }] }, c),
    ]);
    expect(files["f.txt"]).toBe("A B C\n");
    // A write queued behind an edit lands after it (its "before" is the edited text).
    const [, w] = await Promise.all([
      fsEditTool.execute({ path: "f.txt", old_string: "A", new_string: "x" }, c),
      fsWriteTool.execute({ path: "f.txt", content: "final\n" }, c),
    ]);
    expect(files["f.txt"]).toBe("final\n");
    expect(w.details?.kind === "diff" ? w.details.patch : "").toContain("-x B C");
  });

  test("different paths do not block each other", async () => {
    const files = { "a.txt": "a", "b.txt": "b" };
    const locks = new PathLocks();
    const c = ctx(slowEnv(files), { pathLocks: locks });
    let release: () => void = () => {};
    const held = locks.withLock(
      "a.txt",
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const other = await fsEditTool.execute({ path: "b.txt", old_string: "b", new_string: "B" }, c);
    expect(other.isError).toBeUndefined();
    expect(files["b.txt"]).toBe("B");
    release();
    await held;
  });

  test("a throwing tool releases the lock for a waiter queued behind it", async () => {
    const files: Record<string, string> = {};
    const c = ctx(slowEnv(files));
    // Both start together: the second queues while the first (missing file → readFile throws) holds.
    const first = fsEditTool.execute({ path: "missing.txt", old_string: "x", new_string: "y" }, c);
    const second = fsWriteTool.execute({ path: "missing.txt", content: "z" }, c);
    await expect(first).rejects.toThrow("no such file");
    const done = await Promise.race([
      second,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 200)),
    ]);
    expect(done).not.toBe("hung");
    expect(files["missing.txt"]).toBe("z");
  });

  test("a shared ctx.pathLocks excludes edits across two contexts (parent and sub-agent)", async () => {
    const files = { "f.txt": "alpha beta\n" };
    const env = slowEnv(files);
    const shared = new PathLocks();
    await Promise.all([
      fsEditTool.execute(
        { path: "f.txt", old_string: "alpha", new_string: "A" },
        ctx(env, { pathLocks: shared }),
      ),
      fsEditTool.execute(
        { path: "f.txt", old_string: "beta", new_string: "B" },
        ctx(env, { pathLocks: shared }),
      ),
    ]);
    expect(files["f.txt"]).toBe("A B\n");
  });
});
