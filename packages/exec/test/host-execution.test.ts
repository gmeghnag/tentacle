import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { FileTooLargeError } from "@tentacle/core";
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

  test("writes options.stdin to the child and closes it", async () => {
    const r = await env.exec("cat", { stdin: "hello" });
    expect(r.stdout).toBe("hello");
    expect(r.exitCode).toBe(0);
  });

  test("without options.stdin the child's stdin is empty (ignored)", async () => {
    const r = await env.exec("cat");
    expect(r.stdout).toBe("");
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

describe("readBytes", () => {
  test("round-trips a file's bytes and refuses nothing under the limit", async () => {
    const path = join(dir, "bytes.bin");
    await writeFile(path, new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]));
    const bytes = await env.readBytes(path, { maxBytes: 1024 });
    expect([...bytes]).toEqual([0x25, 0x50, 0x44, 0x46, 0x2d, 0x00, 0xff]);
  });

  test("readLimitBytes returns only the head", async () => {
    const path = join(dir, "head.bin");
    await writeFile(path, "0123456789");
    expect(new TextDecoder().decode(await env.readBytes(path, { readLimitBytes: 4 }))).toBe("0123");
  });

  test("a relative path resolves against the configured cwd, as readFile does", async () => {
    await writeFile(join(dir, "relative.txt"), "via cwd");
    expect(new TextDecoder().decode(await env.readBytes("relative.txt"))).toBe("via cwd");
  });

  test("a file over maxBytes is refused before its content is read", async () => {
    const path = join(dir, "big.bin");
    const handle = await open(path, "w");
    await handle.truncate(4096);
    await handle.close();

    const realFile = Bun.file;
    let opens = 0;
    Bun.file = ((...args: Parameters<typeof realFile>) => {
      opens += 1;
      return realFile(...args);
    }) as typeof Bun.file;
    let error: unknown;
    try {
      await env.readBytes(path, { maxBytes: 1024 });
    } catch (caught) {
      error = caught;
    } finally {
      Bun.file = realFile;
    }
    expect(error).toBeInstanceOf(FileTooLargeError);
    expect((error as FileTooLargeError).sizeBytes).toBe(4096);
    expect((error as Error).message).toContain("MiB limit");
    expect(opens).toBe(0);
  });

  test("a missing file explains itself with the configured readHint", async () => {
    const hinted = new HostExecution({
      cwd: dir,
      readHint: () => "that spilled output was removed with its session",
    });
    await expect(hinted.readBytes(join(dir, "gone.bin"))).rejects.toThrow(
      /removed with its session/,
    );
    await expect(hinted.readFile(join(dir, "gone.bin"))).rejects.toThrow(
      /removed with its session/,
    );
  });

  test("a directory is not a regular file", async () => {
    await expect(env.readBytes(dir)).rejects.toThrow(/not a regular file/);
  });
});

describe("child env scrubbing", () => {
  const SECRET = "leak-me";

  // Set env vars for the duration of `fn`, then restore their exact prior
  // state (so the suite stays hermetic regardless of the host environment).
  async function withEnv(vars: Record<string, string>, fn: () => Promise<void>): Promise<void> {
    const saved: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(vars)) {
      saved[key] = process.env[key];
      process.env[key] = value;
    }
    try {
      await fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) {
          delete process.env[key as string];
        } else {
          process.env[key] = value;
        }
      }
    }
  }

  test("exec does not leak inherited secret-looking vars (PATH still present)", async () => {
    await withEnv({ TENTACLE_MODEL_API_KEY: SECRET, MY_ACCESS_TOKEN: SECRET }, async () => {
      const r = await env.exec("printenv");
      const lines = r.stdout.split("\n");
      expect(lines).not.toContain(`TENTACLE_MODEL_API_KEY=${SECRET}`);
      expect(lines).not.toContain(`MY_ACCESS_TOKEN=${SECRET}`);
      // Ordinary vars the child needs must survive the scrub.
      expect(lines.some((l) => l.startsWith("PATH="))).toBe(true);
    });
  });

  test("spawnBackground does not leak inherited secret-looking vars either", async () => {
    await withEnv({ TENTACLE_MODEL_API_KEY: SECRET }, async () => {
      const handle = env.spawnBackground("printenv");
      const text = await new Response(handle.stdout).text();
      await handle.exited;
      expect(text).not.toContain(`TENTACLE_MODEL_API_KEY=${SECRET}`);
      expect(text.split("\n").some((l) => l.startsWith("PATH="))).toBe(true);
    });
  });

  test("an explicit options.env var is still honoured (even if secret-looking)", async () => {
    // Pins the policy: only the *ambient* env is scrubbed; an explicit
    // caller value is an opt-in (same as the MCP stdio transport).
    const r = await env.exec('echo "${MY_CUSTOM_TOKEN:-unset}"', {
      env: { MY_CUSTOM_TOKEN: "explicit" },
    });
    expect(r.stdout.trim()).toBe("explicit");
  });
});
