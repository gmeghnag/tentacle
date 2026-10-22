import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// scripts/install.sh run for real (sh, curl) against a fake release server.
// The "tentacle" asset is a shell stub: `--version` prints its version and
// `update …` logs its arguments, so the hand-off to `tentacle update` is seen.

const SCRIPT = resolve(import.meta.dir, "../install.sh");

function hostTarget(): string {
  const os = process.platform === "darwin" ? "darwin" : "linux";
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return `bun-${os}-${arch}`;
}
const ASSET = `tentacle-${hostTarget()}`;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const stub = (version: string, log: string) =>
  `#!/bin/sh\ncase "$1" in\n  --version) echo "tentacle ${version}" ;;\n  update) echo "$*" >> "${log}" ;;\nesac\n`;

let dir: string;
let server: ReturnType<typeof Bun.serve>;
let hits: string[];
let assets: Record<string, string>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tentacle-install-"));
  hits = [];
  assets = {};
  server = Bun.serve({
    port: 0,
    fetch(req) {
      const name = new URL(req.url).pathname.slice(1);
      hits.push(name);
      const body = assets[name];
      return body === undefined ? new Response("nope", { status: 404 }) : new Response(body);
    },
  });
});
afterEach(async () => {
  server.stop(true);
  await rm(dir, { recursive: true, force: true });
});

function publish(version: string, opts: { badSum?: boolean } = {}): void {
  const bin = stub(version, join(dir, "update.log"));
  assets[ASSET] = bin;
  assets.SHA256SUMS = `${opts.badSum ? sha("other") : sha(bin)}  ${ASSET}\n`;
}

async function install(env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  const p = Bun.spawn(["sh", SCRIPT], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      TENTACLE_INSTALL_DIR: join(dir, "bin"),
      TENTACLE_CONFIG_DIR: join(dir, "cfg"),
      TENTACLE_DOWNLOAD_BASE: `http://127.0.0.1:${server.port}`,
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = (await new Response(p.stdout).text()) + (await new Response(p.stderr).text());
  return { code: await p.exited, out };
}

const installed = () => join(dir, "bin", "tentacle");
const leftovers = () =>
  existsSync(join(dir, "bin"))
    ? readdirSync(join(dir, "bin")).filter((f) => f.startsWith("."))
    : [];
const updateLog = () =>
  existsSync(join(dir, "update.log")) ? readFileSync(join(dir, "update.log"), "utf8") : "";

describe("scripts/install.sh", () => {
  test("installs the verified CLI, then hands the pod binaries to `tentacle update` for that version", async () => {
    publish("0.1.0");
    const r = await install();
    expect(r.code).toBe(0);
    expect(readFileSync(installed(), "utf8")).toBe(assets[ASSET] ?? "");
    expect(updateLog()).toBe("update --version v0.1.0\n");
    expect(leftovers()).toEqual([]);
  });

  test("a checksum mismatch installs nothing and leaves no staged file", async () => {
    publish("0.1.0", { badSum: true });
    writeFileSync(join(dir, "keep"), "");
    const r = await install();
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("checksum mismatch");
    expect(existsSync(installed())).toBe(false);
    expect(leftovers()).toEqual([]);
    expect(updateLog()).toBe("");
  });

  test("a failed install keeps the existing tentacle untouched", async () => {
    publish("0.1.0", { badSum: true });
    await install({ TENTACLE_NO_POD_BINARIES: "1" }); // creates bin/ (fails)
    writeFileSync(installed(), "old tentacle");
    const r = await install();
    expect(r.code).not.toBe(0);
    expect(readFileSync(installed(), "utf8")).toBe("old tentacle");
  });

  test("a version before 0.1.0 is refused before any download", async () => {
    publish("0.1.0-beta.1");
    for (const v of ["v0.1.0-beta.1", "0.0.9", "latest-ish"]) {
      const r = await install({ TENTACLE_VERSION: v });
      expect(r.code).not.toBe(0);
    }
    expect(hits).toEqual([]);
  });

  test("a pinned version must match what the release actually contains", async () => {
    publish("0.1.0");
    const r = await install({ TENTACLE_VERSION: "v0.2.0" });
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("asked for v0.2.0 but the release contains tentacle 0.1.0");
    expect(existsSync(installed())).toBe(false);
  });

  test("latest resolving to a pre-0.1.0 build is refused", async () => {
    publish("0.1.0-beta.1");
    const r = await install();
    expect(r.code).not.toBe(0);
    expect(existsSync(installed())).toBe(false);
  });

  test("TENTACLE_NO_POD_BINARIES=1 skips `tentacle update`", async () => {
    publish("0.1.0");
    const r = await install({ TENTACLE_NO_POD_BINARIES: "1" });
    expect(r.code).toBe(0);
    expect(updateLog()).toBe("");
    expect(r.out).toContain("pod binaries skipped");
  });
});
