/**
 * `HostExecution.readConfinedBytes` — the binary, CONFINED read behind `present`
 * (docs/feat/model-artifacts.md D3, T2). Reads by `fs_read` stay unconfined;
 * these may only ship what is inside the workspace and not secret-looking.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostExecution, type HostExecutionConfig, WorkspaceReadError } from "../src/index.ts";

let base: string;
let root: string;
let outside: string;

function envWith(config: Partial<HostExecutionConfig> = {}): HostExecution {
  return new HostExecution({ cwd: root, ...config });
}

/** The refusal's reason, or "ok" when the read succeeded. */
async function reasonOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    return "ok";
  } catch (error) {
    if (error instanceof WorkspaceReadError) {
      return error.reason;
    }
    throw error;
  }
}

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), "harness-readbytes-"));
  root = join(base, "workspace");
  outside = join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

describe("readConfinedBytes — happy path", () => {
  test("reads a workspace file as bytes, with its real path", async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 255]);
    mkdirSync(join(root, "out"));
    writeFileSync(join(root, "out", "a.png"), png);
    const env = envWith();
    const read = await env.readConfinedBytes("out/a.png", { maxBytes: 100 });
    expect(Array.from(read.bytes)).toEqual(Array.from(png));
    expect(read.realPath.endsWith(join("workspace", "out", "a.png"))).toBe(true);
    // Absolute paths inside the root work too.
    expect(
      (await env.readConfinedBytes(join(root, "out", "a.png"), { maxBytes: 8 })).bytes.length,
    ).toBe(8);
  });

  test("an empty file reads as zero bytes (the tool decides what to do with it)", async () => {
    writeFileSync(join(root, "empty.txt"), "");
    expect((await envWith().readConfinedBytes("empty.txt", { maxBytes: 10 })).bytes.length).toBe(0);
  });
});

describe("T2.1/T2.2 — confinement by REAL path", () => {
  test("../outside is refused", async () => {
    writeFileSync(join(outside, "x.png"), "x");
    expect(await reasonOf(envWith().readConfinedBytes("../outside/x.png", { maxBytes: 10 }))).toBe(
      "outside",
    );
    expect(
      await reasonOf(envWith().readConfinedBytes(join(outside, "x.png"), { maxBytes: 10 })),
    ).toBe("outside");
  });

  test("an in-root symlink to an outside target is refused; in-root → in-root is allowed", async () => {
    writeFileSync(join(outside, "id_like.txt"), "secret");
    symlinkSync(join(outside, "id_like.txt"), join(root, "innocent.txt"));
    writeFileSync(join(root, "real.txt"), "hello");
    symlinkSync(join(root, "real.txt"), join(root, "alias.txt"));
    const env = envWith();
    expect(await reasonOf(env.readConfinedBytes("innocent.txt", { maxBytes: 100 }))).toBe(
      "outside",
    );
    const alias = await env.readConfinedBytes("alias.txt", { maxBytes: 100 });
    expect(new TextDecoder().decode(alias.bytes)).toBe("hello");
    expect(alias.realPath.endsWith("real.txt")).toBe(true);
  });

  test("a symlinked DIRECTORY pointing out is refused by its target", async () => {
    writeFileSync(join(outside, "plot.png"), "x");
    symlinkSync(outside, join(root, "linked"));
    expect(await reasonOf(envWith().readConfinedBytes("linked/plot.png", { maxBytes: 10 }))).toBe(
      "outside",
    );
  });

  test("writable dirs do NOT widen reads: only the workspace root counts", async () => {
    writeFileSync(join(outside, "x.txt"), "x");
    const env = envWith({ writableDirs: [outside] });
    expect(await reasonOf(env.readConfinedBytes(join(outside, "x.txt"), { maxBytes: 10 }))).toBe(
      "outside",
    );
  });

  test("dangling and looping links are refused; a missing file is 'missing'", async () => {
    symlinkSync(join(root, "nowhere"), join(root, "dangling"));
    symlinkSync(join(root, "loop-b"), join(root, "loop-a"));
    symlinkSync(join(root, "loop-a"), join(root, "loop-b"));
    const env = envWith();
    expect(await reasonOf(env.readConfinedBytes("dangling", { maxBytes: 10 }))).toBe(
      "unresolvable",
    );
    expect(await reasonOf(env.readConfinedBytes("loop-a", { maxBytes: 10 }))).toBe("unresolvable");
    expect(await reasonOf(env.readConfinedBytes("absent.png", { maxBytes: 10 }))).toBe("missing");
  });

  test("a file swapped for an outside link between the check and the open is refused", async () => {
    writeFileSync(join(root, "a.txt"), "inside");
    writeFileSync(join(outside, "s.txt"), "outside");
    const env = envWith({
      beforeOpen: (real) => {
        renameSync(real, `${real}.moved`);
        symlinkSync(join(outside, "s.txt"), real);
      },
    });
    expect(await reasonOf(env.readConfinedBytes("a.txt", { maxBytes: 100 }))).not.toBe("ok");
  });

  test("a parent DIRECTORY swapped for an outside link after the check is caught by the re-check", async () => {
    mkdirSync(join(root, "sub"));
    writeFileSync(join(root, "sub", "f.txt"), "inside");
    writeFileSync(join(outside, "f.txt"), "outside");
    const env = envWith({
      beforeOpen: () => {
        renameSync(join(root, "sub"), join(root, "sub.moved"));
        symlinkSync(outside, join(root, "sub"));
      },
    });
    expect(await reasonOf(env.readConfinedBytes("sub/f.txt", { maxBytes: 100 }))).toBe("outside");
  });
});

describe("T2.3/T2.4 — size, file type, growth", () => {
  test("a file of maxBytes+1 is refused WITHOUT reading it", async () => {
    writeFileSync(join(root, "big.bin"), new Uint8Array(11));
    let reads = 0;
    const env = envWith({
      beforeRead: () => {
        reads += 1;
      },
    });
    const error = await env.readConfinedBytes("big.bin", { maxBytes: 10 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WorkspaceReadError);
    expect(error instanceof WorkspaceReadError ? error.reason : "").toBe("too_large");
    expect(reads).toBe(0);
    // Exactly maxBytes is fine, and the seam ran (the spy is live).
    writeFileSync(join(root, "ok.bin"), new Uint8Array(10));
    expect((await env.readConfinedBytes("ok.bin", { maxBytes: 10 })).bytes.length).toBe(10);
    expect(reads).toBe(1);
  });

  test("the size message is model-actionable, in MiB", async () => {
    writeFileSync(join(root, "big.bin"), new Uint8Array(3 * 1024 * 1024 + 200 * 1024));
    const error = await envWith()
      .readConfinedBytes("big.bin", { maxBytes: 2 * 1024 * 1024 })
      .catch((e: unknown) => e);
    expect(error instanceof Error ? error.message : "").toContain(
      "file too large (3.2 MiB > 2 MiB)",
    );
  });

  test("a file that grows during the read is refused, not truncated", async () => {
    writeFileSync(join(root, "log.txt"), "12345");
    const env = envWith({ beforeRead: (real) => appendFileSync(real, "6789") });
    expect(await reasonOf(env.readConfinedBytes("log.txt", { maxBytes: 100 }))).toBe("changed");
  });

  test("a FIFO and a directory are refused (never blocks on the FIFO)", async () => {
    mkdirSync(join(root, "dir"));
    const env = envWith();
    expect(await reasonOf(env.readConfinedBytes("dir", { maxBytes: 10 }))).toBe("not_file");
    expect(await reasonOf(env.readConfinedBytes(".", { maxBytes: 10 }))).toBe("not_file");
    const mk = Bun.spawnSync(["mkfifo", join(root, "pipe")]);
    expect(mk.exitCode).toBe(0);
    expect(await reasonOf(env.readConfinedBytes("pipe", { maxBytes: 10 }))).toBe("not_file");
  });
});

describe("T2.5 — secret-looking files inside the workspace", () => {
  test(".env, .env.local, a/.ssh/config, x.pem are refused; env.md is allowed", async () => {
    mkdirSync(join(root, "a", ".ssh"), { recursive: true });
    for (const name of [".env", ".env.local", "a/.ssh/config", "x.pem"]) {
      writeFileSync(join(root, name), "SECRET=1");
    }
    writeFileSync(join(root, "env.md"), "# env");
    const env = envWith();
    for (const name of [".env", ".env.local", "a/.ssh/config", "x.pem"]) {
      expect(await reasonOf(env.readConfinedBytes(name, { maxBytes: 100 })), name).toBe("secret");
    }
    expect(await reasonOf(env.readConfinedBytes("env.md", { maxBytes: 100 }))).toBe("ok");
  });

  test("an innocent-looking link to a secret file is refused by its TARGET's name", async () => {
    writeFileSync(join(root, ".env"), "SECRET=1");
    symlinkSync(join(root, ".env"), join(root, "report.txt"));
    expect(await reasonOf(envWith().readConfinedBytes("report.txt", { maxBytes: 100 }))).toBe(
      "secret",
    );
  });

  test("a workspace that itself lives under a secret-named dir still works (segments are workspace-relative)", async () => {
    const nested = join(base, ".docker", "project");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, "chart.svg"), "<svg/>");
    const env = new HostExecution({ cwd: nested });
    expect(await reasonOf(env.readConfinedBytes("chart.svg", { maxBytes: 100 }))).toBe("ok");
  });
});
