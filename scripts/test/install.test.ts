import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

// The macOS voice helper (docs/feat/voice-release.md). `uname` is faked on PATH,
// so the Darwin path runs on a Linux CI host too (every asset is a shell stub).
describe("scripts/install.sh — the voice helper", () => {
  const VOICE = "tentacle-voice-darwin";
  const voiceStub = (runs = true) =>
    runs
      ? '#!/bin/sh\n[ "$1" = --version ] && echo "tentacle-voice protocol 1"\n'
      : "#!/bin/sh\nexit 1\n"; // what dyld does on a Mac older than the helper's macOS 26

  function fakeUname(os: string, arch: string): string {
    const bin = join(dir, "fakebin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(
      join(bin, "uname"),
      `#!/bin/sh\ncase "$1" in -s) echo ${os} ;; -m) echo ${arch} ;; esac\n`,
    );
    chmodSync(join(bin, "uname"), 0o755);
    return `${bin}:${process.env.PATH ?? ""}`;
  }

  /** A release for `target`, optionally with the helper (listed, and with a good or bad sum). */
  function publishFor(
    target: string,
    voice: { body?: string; badSum?: boolean; listedOnly?: boolean } | null,
  ): void {
    const cli = stub("0.1.0", join(dir, "update.log"));
    const name = `tentacle-${target}`;
    assets[name] = cli;
    let sums = `${sha(cli)}  ${name}\n`;
    if (voice) {
      const body = voice.body ?? voiceStub();
      if (!voice.listedOnly) assets[VOICE] = body;
      sums += `${voice.badSum ? sha("other") : sha(body)}  ${VOICE}\n`;
    }
    assets.SHA256SUMS = sums;
  }

  const helper = () => join(dir, "bin", "tentacle-voice");
  const mac = () => ({ PATH: fakeUname("Darwin", "arm64"), TENTACLE_NO_POD_BINARIES: "1" });

  test("on macOS the verified helper is installed next to tentacle, executable", async () => {
    publishFor("bun-darwin-arm64", {});
    const r = await install(mac());
    expect(r.code).toBe(0);
    expect(readFileSync(installed(), "utf8")).toBe(assets["tentacle-bun-darwin-arm64"] ?? "");
    expect(readFileSync(helper(), "utf8")).toBe(assets[VOICE] ?? "");
    expect(statSync(helper()).mode & 0o111).not.toBe(0);
    expect(r.out).toContain(`✓ ${helper()}`);
    expect(leftovers()).toEqual([]);
  });

  test("a release without the helper (older) installs the CLI and says so in one line", async () => {
    publishFor("bun-darwin-arm64", null);
    const r = await install(mac());
    expect(r.code).toBe(0);
    expect(existsSync(installed())).toBe(true);
    expect(existsSync(helper())).toBe(false);
    expect(hits).not.toContain(VOICE); // known absent from SHA256SUMS: not even requested
    expect(r.out.split("\n").filter((l) => l.includes("voice helper"))).toHaveLength(1);
  });

  test("a helper checksum mismatch keeps the old helper, installs the CLI, exits 0", async () => {
    publishFor("bun-darwin-arm64", { badSum: true });
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(helper(), "old helper");
    const r = await install(mac());
    expect(r.code).toBe(0);
    expect(existsSync(installed())).toBe(true);
    expect(readFileSync(helper(), "utf8")).toBe("old helper");
    expect(r.out).toContain("checksum mismatch for tentacle-voice-darwin");
    expect(leftovers()).toEqual([]);
  });

  test("a helper listed but not downloadable is skipped, not fatal", async () => {
    publishFor("bun-darwin-arm64", { listedOnly: true });
    const r = await install(mac());
    expect(r.code).toBe(0);
    expect(existsSync(installed())).toBe(true);
    expect(existsSync(helper())).toBe(false);
    expect(r.out).toContain("voice helper");
    expect(leftovers()).toEqual([]);
  });

  test("a helper that does not run here (macOS older than 26) is not installed", async () => {
    publishFor("bun-darwin-arm64", { body: voiceStub(false) });
    const r = await install(mac());
    expect(r.code).toBe(0);
    expect(existsSync(installed())).toBe(true);
    expect(existsSync(helper())).toBe(false);
    expect(r.out).toContain("macOS 26");
    expect(leftovers()).toEqual([]);
  });

  test("the helper is installed before the pod binaries, so their failure does not lose it", async () => {
    publishFor("bun-darwin-arm64", {});
    // The CLI stub fails `update`, as a network error fetching the pod binaries would.
    const failing =
      '#!/bin/sh\ncase "$1" in\n  --version) echo "tentacle 0.1.0" ;;\n  *) exit 1 ;;\nesac\n';
    assets["tentacle-bun-darwin-arm64"] = failing;
    assets.SHA256SUMS = `${sha(failing)}  tentacle-bun-darwin-arm64\n${sha(voiceStub())}  ${VOICE}\n`;
    const r = await install({ PATH: fakeUname("Darwin", "arm64") });
    expect(r.code).not.toBe(0);
    expect(readFileSync(helper(), "utf8")).toBe(voiceStub());
  });

  test("the asset name is one truth: CI builds, uploads and requires the name install.sh fetches", () => {
    const yml = readFileSync(resolve(import.meta.dir, "../../.github/workflows/build.yml"), "utf8");
    const sh = readFileSync(SCRIPT, "utf8");
    expect(sh).toContain(`asset=${VOICE}`);
    expect(yml).toContain(`mv dist/tentacle-voice dist/${VOICE}`);
    expect(yml).toMatch(new RegExp(`upload-artifact@v4\\s+with:\\s+name: ${VOICE}\\b`));
    // The release job refuses to publish without it, and it lands in SHA256SUMS
    // through the `tentacle-*` download pattern + `sha256sum tentacle-*`.
    expect(yml).toMatch(new RegExp(`for f in [^;]*\\b${VOICE}\\b[^;]*; do`));
    expect(yml).toContain("needs: [build, voice]");
  });

  test("on Linux the helper is never fetched, even when the release lists it", async () => {
    publishFor("bun-linux-x64", {});
    const r = await install({ PATH: fakeUname("Linux", "x86_64"), TENTACLE_NO_POD_BINARIES: "1" });
    expect(r.code).toBe(0);
    expect(existsSync(installed())).toBe(true);
    expect(hits).not.toContain(VOICE);
    expect(existsSync(helper())).toBe(false);
    expect(r.out).not.toContain("voice helper");
  });
});
