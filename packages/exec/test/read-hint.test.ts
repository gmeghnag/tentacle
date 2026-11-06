import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostExecution, WorkspaceWriteError } from "../src/index.ts";

let work: string;
let cache: string;
beforeAll(async () => {
  work = await mkdtemp(join(tmpdir(), "he-work-"));
  cache = await mkdtemp(join(tmpdir(), "he-cache-"));
});
afterAll(async () => {
  await rm(work, { recursive: true, force: true });
  await rm(cache, { recursive: true, force: true });
});

describe("workspace confinement stays (docs/fix/tool-output-location.md)", () => {
  test("a write outside the root still throws: the spill gets its own writer instead", async () => {
    const env = new HostExecution({ cwd: work, root: work });
    await expect(env.writeFile(join(cache, "x.txt"), "no")).rejects.toBeInstanceOf(
      WorkspaceWriteError,
    );
  });
});

describe("readHint", () => {
  const hint = (p: string): string | undefined =>
    p.startsWith(cache) ? "tool output no longer available" : undefined;

  test("a missing file under the hinted prefix says why", async () => {
    const env = new HostExecution({ cwd: work, root: work, readHint: hint });
    await expect(env.readFile(join(cache, "gone.txt"))).rejects.toThrow(
      "tool output no longer available",
    );
  });

  test("the message names the path", async () => {
    const env = new HostExecution({ cwd: work, root: work, readHint: hint });
    await expect(env.readFile(join(cache, "gone.txt"))).rejects.toThrow(join(cache, "gone.txt"));
  });

  test("a missing file elsewhere keeps the OS error", async () => {
    const env = new HostExecution({ cwd: work, root: work, readHint: hint });
    const error = await env.readFile(join(work, "nope.txt")).catch((e: unknown) => e);
    expect(String(error)).not.toContain("no longer available");
    expect((error as NodeJS.ErrnoException).code).toBe("ENOENT");
  });

  test("an existing file under the prefix reads normally", async () => {
    const env = new HostExecution({ cwd: work, root: work, readHint: hint });
    await Bun.write(join(cache, "here.txt"), "content");
    expect(await env.readFile(join(cache, "here.txt"))).toBe("content");
  });

  test("a non-ENOENT error under the prefix is unchanged", async () => {
    const env = new HostExecution({ cwd: work, root: work, readHint: hint });
    // Reading a directory is EISDIR, not "removed".
    const error = await env.readFile(cache).catch((e: unknown) => e);
    expect(String(error)).not.toContain("no longer available");
  });

  test("no hint configured: today's behaviour", async () => {
    const env = new HostExecution({ cwd: work, root: work });
    const error = await env.readFile(join(cache, "gone.txt")).catch((e: unknown) => e);
    expect(String(error)).not.toContain("no longer available");
  });
});
