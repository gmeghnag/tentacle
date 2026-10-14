import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { HostExecution } from "../src/index.ts";

let dir: string;
let env: HostExecution;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "harness-exec-"));
  env = new HostExecution({ cwd: dir });
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("HostExecution", () => {
  test("captures stdout and a zero exit code", async () => {
    const r = await env.exec("echo hello");
    expect(r.stdout.trim()).toBe("hello");
    expect(r.exitCode).toBe(0);
  });

  test("reports a non-zero exit code and stderr", async () => {
    const r = await env.exec("echo oops 1>&2; exit 3");
    expect(r.exitCode).toBe(3);
    expect(r.stderr.trim()).toBe("oops");
  });

  test("runs in the configured working directory", async () => {
    const r = await env.exec("pwd");
    // macOS temp dirs are symlinked (/var -> /private/var), so compare the
    // unique basename rather than the full path.
    expect(basename(r.stdout.trim())).toBe(basename(dir));
  });

  test("write then read round-trips a relative path", async () => {
    await env.writeFile("note.txt", "content here");
    expect(await env.readFile("note.txt")).toBe("content here");
  });

  test("a timeout aborts a long-running command", async () => {
    const r = await env.exec("sleep 5", { timeoutMs: 100 });
    expect(r.exitCode).not.toBe(0);
  });

  test("an external abort signal kills the command", async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    const r = await env.exec("sleep 5", { signal: ac.signal });
    expect(r.exitCode).not.toBe(0);
  });
});
