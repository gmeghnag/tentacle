/**
 * docs/feat/image-heic.md T3: the real decoder, no skip — macOS converts and
 * refuses its own broken output; any other host has no converter at all.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readJpegHeader, sniffImageType } from "@tentacle/core";
import { defaultHeicConverter, sipsSandboxProfile } from "../src/heic-convert.ts";

const fixture = async (name: string) =>
  new Uint8Array(
    await Bun.file(`${import.meta.dir}/../../core/test/fixtures/heic/${name}`).arrayBuffer(),
  );
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const LIMITS = { maxEdge: 4032, maxBytes: 1_000_000 };

/** One command under a sandbox profile, as the OS enforces it. */
async function confined(profile: string, command: string[]) {
  const child = Bun.spawn(["/usr/bin/sandbox-exec", "-p", profile, ...command], {
    env: {},
    stdin: "ignore",
    stdout: "pipe",
    stderr: "ignore",
  });
  const stdout = await new Response(child.stdout).text();
  return { code: await child.exited, stdout };
}

describe("the host's HEIC decoder", () => {
  test("converts on macOS, deterministically; absent elsewhere", async () => {
    const convert = defaultHeicConverter();
    if (process.platform !== "darwin") {
      expect(convert).toBeUndefined();
      return;
    }
    if (convert === undefined) throw new Error("macOS has no HEIC converter");
    expect(defaultHeicConverter()).toBe(convert);
    const heic = await fixture("small-orient-6.heic");
    const first = await convert(heic, LIMITS);
    const second = await convert(heic, LIMITS);
    if ("refused" in first || "refused" in second) {
      throw new Error(JSON.stringify([first, second]));
    }
    expect(sniffImageType(first.bytes)).toEqual({ kind: "image", mimeType: "image/jpeg" });
    expect(readJpegHeader(first.bytes)).toMatchObject({ width: 64, height: 48, orientation: 6 });
    expect(sha(second.bytes)).toBe(sha(first.bytes));
    // Shrinking lands exactly on the side asked.
    expect(await convert(heic, { ...LIMITS, maxEdge: 47 })).toMatchObject({ width: 47 });
  });

  test("macOS: a process started with another TMPDIR still converts", async () => {
    const convert = defaultHeicConverter();
    if (process.platform !== "darwin") {
      expect(convert).toBeUndefined();
      return;
    }
    if (convert === undefined) throw new Error("macOS has no HEIC converter");
    // `sips` writes its scratch in the per-user temp dir whatever TMPDIR says,
    // so the sandbox's one writable place must not follow TMPDIR.
    const other = await mkdtemp(join(tmpdir(), "heic-tmpdir-"));
    const before = process.env.TMPDIR;
    process.env.TMPDIR = other;
    try {
      expect(await convert(await fixture("small-orient-6.heic"), LIMITS)).toMatchObject({
        width: 64,
        height: 48,
      });
    } finally {
      if (before === undefined) {
        const key = "TMPDIR";
        delete process.env[key];
      } else {
        process.env.TMPDIR = before;
      }
      await rm(other, { recursive: true, force: true });
    }
  });

  test("macOS: the confined process can start no other program", async () => {
    if (process.platform !== "darwin") {
      expect(defaultHeicConverter()).toBeUndefined();
      return;
    }
    const profile = sipsSandboxProfile(await realpath(tmpdir()));
    // A decoder taken over by its input must not get a program run for it.
    expect((await confined(profile, ["/usr/bin/true"])).code).not.toBe(0);
  });

  test("macOS: the confined process cannot fork", async () => {
    if (process.platform !== "darwin") {
      expect(defaultHeicConverter()).toBeUndefined();
      return;
    }
    // `sips` never forks on request, so a shell takes its place in the exec rule.
    const profile = sipsSandboxProfile(await realpath(tmpdir())).replaceAll(
      '"/usr/bin/sips"',
      '"/bin/bash"',
    );
    // Control: the shell itself runs under it.
    expect(await confined(profile, ["/bin/bash", "-c", "echo alive"])).toEqual({
      code: 0,
      stdout: "alive\n",
    });
    const forked = await confined(profile, ["/bin/bash", "-c", "(echo child); :"]);
    expect(forked.stdout).toBe("");
  });

  test("macOS: a file cut in half is refused, never a broken picture", async () => {
    const convert = defaultHeicConverter();
    if (process.platform !== "darwin") {
      expect(convert).toBeUndefined();
      return;
    }
    if (convert === undefined) throw new Error("macOS has no HEIC converter");
    const heic = await fixture("small-orient-6.heic");
    const cut = await convert(heic.subarray(0, Math.floor(heic.length / 2)), LIMITS);
    expect(cut).toHaveProperty("refused");
  });
});
