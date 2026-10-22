import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { FetchLike } from "../src/pod-binary-download.ts";
import { EXIT_UPDATE_AVAILABLE, type UpdateDeps, runUpdate, spawnVersion } from "../src/update.ts";
import { findVersionMarker } from "../src/version-marker.ts";
import { formatVersionMarker } from "../src/version.ts";

const REPO = "gmeghnag/tentacle";
const SELF = "tentacle-bun-darwin-arm64";
const PODS = ["tentacle-bun-linux-x64", "tentacle-bun-linux-arm64"] as const;

/** A fake compiled binary of `version` for `asset` (marker near the end, like Bun's payload). */
const binary = (asset: string, version: string | undefined): string =>
  `${asset}:${"_".repeat(100)}${version ? formatVersionMarker(version) : ""}${"_".repeat(20)}`;
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

interface Release {
  readonly assets: Record<string, string>;
  /** Override the published SHA256SUMS text (e.g. a wrong digest). */
  readonly sums?: string;
}

/**
 * An in-memory GitHub: `/releases/latest` redirects to `latest`, release files
 * are served (or 404), and `override` can replace any URL's response.
 */
function fakeGitHub(releases: Record<string, Release>, latest: string | null) {
  const urls: string[] = [];
  const override = new Map<string, () => Response>();
  const fetch: FetchLike = async (url) => {
    urls.push(url);
    const custom = override.get(url);
    if (custom) {
      return custom();
    }
    if (url === `https://github.com/${REPO}/releases/latest`) {
      return latest
        ? new Response(null, {
            status: 302,
            headers: { location: `https://github.com/${REPO}/releases/tag/${latest}` },
          })
        : new Response("Not Found", { status: 404 });
    }
    const m = new RegExp(`^https://github.com/${REPO}/releases/download/([^/]+)/(.+)$`).exec(url);
    const release = m?.[1] ? releases[m[1]] : undefined;
    const name = m?.[2];
    if (!release || !name) {
      return new Response("Not Found", { status: 404 });
    }
    if (name === "SHA256SUMS") {
      return new Response(
        release.sums ??
          Object.entries(release.assets)
            .map(([n, body]) => `${sha(body)}  ${n}`)
            .join("\n"),
      );
    }
    const body = release.assets[name];
    return body === undefined ? new Response("Not Found", { status: 404 }) : new Response(body);
  };
  /** Asset downloads only (not SHA256SUMS / latest). */
  const downloads = () =>
    urls.filter((u) => u.includes("/download/") && !u.endsWith("/SHA256SUMS"));
  return { fetch, urls, override, downloads };
}

const releaseOf = (version: string, opts: { selfVersion?: string } = {}): Release => ({
  assets: {
    [SELF]: binary(SELF, opts.selfVersion ?? version),
    [PODS[0]]: binary(PODS[0], version),
    [PODS[1]]: binary(PODS[1], version),
  },
});

let root: string;
let installDir: string;
let configDir: string;
let execPath: string;
let out: string[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tentacle-update-"));
  installDir = join(root, "install");
  configDir = join(root, "config");
  execPath = join(installDir, "tentacle");
  mkdirSync(installDir, { recursive: true });
  out = [];
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** Seed the current install: the CLI at `cli`, pods at `pods` (undefined = absent, "" = no marker). */
function install(cli: string, pods: [string | undefined, string | undefined]): void {
  writeFileSync(execPath, binary(SELF, cli));
  pods.forEach((version, i) => {
    const name = PODS[i] as string;
    if (version !== undefined) {
      mkdirSync(join(configDir, "bin"), { recursive: true });
      writeFileSync(join(configDir, "bin", name), binary(name, version || undefined));
    }
  });
}
const versionOf = (path: string): string | undefined =>
  existsSync(path) ? findVersionMarker(new Uint8Array(readFileSync(path))) : undefined;
const selfVersion = (): string | undefined => versionOf(execPath);
const podVersions = () => PODS.map((p) => versionOf(join(configDir, "bin", p)));
/** No `.tmp` staging file anywhere. */
const temps = (): string[] =>
  [installDir, join(configDir, "bin")]
    .filter((d) => existsSync(d))
    .flatMap((d) => readdirSync(d).filter((f) => f.endsWith(".tmp")));

function deps(gh: ReturnType<typeof fakeGitHub>, extra: Partial<UpdateDeps> = {}): UpdateDeps {
  return {
    appVersion: "0.3.0",
    execPath,
    configDir,
    platform: "darwin",
    arch: "arm64",
    fetch: gh.fetch,
    repo: REPO,
    // The "new binary" answers --version from its own marker, like the real one.
    runVersion: async (path) =>
      `tentacle ${findVersionMarker(new Uint8Array(readFileSync(path))) ?? "?"}\n`,
    write: (t) => out.push(t),
    ...extra,
  };
}

describe("tentacle update", () => {
  test("up to date: CLI and pods at the latest → exit 0, nothing downloaded", async () => {
    install("0.3.0", ["0.3.0", "0.3.0"]);
    const gh = fakeGitHub({ "v0.3.0": releaseOf("0.3.0") }, "v0.3.0");
    expect(await runUpdate({ check: false }, deps(gh))).toBe(0);
    expect(out.join("")).toContain("tentacle 0.3.0 is up to date (v0.3.0)");
    expect(gh.downloads()).toEqual([]);
  });

  test("update available: the CLI and both pods move to latest, the CLI renamed LAST", async () => {
    install("0.3.0", ["0.3.0", "0.3.0"]);
    const gh = fakeGitHub({ "v0.4.0": releaseOf("0.4.0") }, "v0.4.0");
    const renames: string[] = [];
    const { rename } = await import("node:fs/promises");
    const code = await runUpdate(
      { check: false },
      deps(gh, {
        rename: async (from, to) => {
          renames.push(to);
          await rename(from, to);
        },
      }),
    );
    expect(code).toBe(0);
    expect(selfVersion()).toBe("0.4.0");
    expect(podVersions()).toEqual(["0.4.0", "0.4.0"]);
    expect(renames.at(-1)).toBe(execPath);
    expect(renames).toHaveLength(3);
    expect(temps()).toEqual([]);
    expect(out.join("")).toContain("tentacle 0.3.0 → 0.4.0");
  });

  test("--check: exit 10 when an update is available, 0 when current; never writes", async () => {
    install("0.3.0", ["0.3.0", "0.3.0"]);
    const gh = fakeGitHub({ "v0.4.0": releaseOf("0.4.0") }, "v0.4.0");
    expect(await runUpdate({ check: true }, deps(gh))).toBe(EXIT_UPDATE_AVAILABLE);
    expect(selfVersion()).toBe("0.3.0");
    expect(gh.downloads()).toEqual([]);
    expect(gh.urls.some((u) => u.endsWith("/SHA256SUMS"))).toBe(false);

    const current = fakeGitHub({ "v0.3.0": releaseOf("0.3.0") }, "v0.3.0");
    expect(await runUpdate({ check: true }, deps(current))).toBe(0);
    // A stale pod alone is "an update is available" too (update would fill it).
    install("0.3.0", ["0.2.0", "0.3.0"]);
    expect(await runUpdate({ check: true }, deps(current))).toBe(EXIT_UPDATE_AVAILABLE);
  });

  test("--version downgrades to that exact release (CLI and pods)", async () => {
    install("0.4.0", ["0.4.0", "0.4.0"]);
    const gh = fakeGitHub({ "v0.3.0": releaseOf("0.3.0"), "v0.4.0": releaseOf("0.4.0") }, "v0.4.0");
    expect(
      await runUpdate({ check: false, version: "0.3.0" }, deps(gh, { appVersion: "0.4.0" })),
    ).toBe(0);
    expect(selfVersion()).toBe("0.3.0");
    expect(podVersions()).toEqual(["0.3.0", "0.3.0"]);
    // --version never asks for "latest".
    expect(gh.urls.some((u) => u.endsWith("/releases/latest"))).toBe(false);
  });

  test("an older latest never downgrades implicitly", async () => {
    install("0.5.0", ["0.5.0", "0.5.0"]);
    const gh = fakeGitHub({ "v0.4.0": releaseOf("0.4.0") }, "v0.4.0");
    expect(await runUpdate({ check: true }, deps(gh, { appVersion: "0.5.0" }))).toBe(0);
    expect(out.join("")).toContain("tentacle 0.5.0 is newer than latest (v0.4.0); kept");
  });

  test("ahead with stale pods: nothing is fetched at the unreleased tag; exit 0 + a --version hint", async () => {
    install("0.5.0", ["0.4.0", undefined]);
    const gh = fakeGitHub({ "v0.4.0": releaseOf("0.4.0") }, "v0.4.0");
    expect(await runUpdate({ check: true }, deps(gh, { appVersion: "0.5.0" }))).toBe(0);
    expect(await runUpdate({ check: false }, deps(gh, { appVersion: "0.5.0" }))).toBe(0);
    expect(gh.urls.some((u) => u.includes("/download/"))).toBe(false);
    expect(podVersions()).toEqual(["0.4.0", undefined]);
    expect(out.join("")).toContain("tentacle update --version v0.5.0");
  });

  test("an install that is not this tentacle is never overwritten (marker ≠ appVersion)", async () => {
    install("0.3.0", ["0.3.0", "0.3.0"]);
    writeFileSync(execPath, "#!/bin/sh\necho some other program\n");
    const gh = fakeGitHub({ "v0.4.0": releaseOf("0.4.0") }, "v0.4.0");
    expect(await runUpdate({ check: false }, deps(gh))).toBe(1);
    expect(out.join("")).toContain(`${execPath} is not tentacle 0.3.0`);
    expect(gh.downloads()).toEqual([]);
    expect(readFileSync(execPath, "utf8")).toContain("some other program");
  });

  test("stale temps left by a killed run are removed on start; a fresh one (a live run) is kept", async () => {
    install("0.3.0", ["0.3.0", "0.3.0"]);
    const old = new Date(Date.now() - 2 * 60 * 60_000);
    const staleSelf = join(installDir, `.${SELF}.0123456789ab.tmp`);
    const stalePod = join(configDir, "bin", `.${PODS[0]}.0123456789ab.tmp`);
    const live = join(configDir, "bin", `.${PODS[1]}.ba9876543210.tmp`);
    const unrelated = join(installDir, ".something-else.tmp");
    for (const f of [staleSelf, stalePod, live, unrelated]) {
      writeFileSync(f, "partial");
    }
    for (const f of [staleSelf, stalePod, unrelated]) {
      utimesSync(f, old, old);
    }
    const gh = fakeGitHub({ "v0.3.0": releaseOf("0.3.0") }, "v0.3.0");
    expect(await runUpdate({ check: false }, deps(gh))).toBe(0);
    expect(existsSync(staleSelf)).toBe(false);
    expect(existsSync(stalePod)).toBe(false);
    expect(existsSync(live)).toBe(true);
    expect(existsSync(unrelated)).toBe(true);
  });

  test("--version before 0.1.0 (pre-marker builds) is refused before any request", async () => {
    install("0.3.0", ["0.3.0", "0.3.0"]);
    const gh = fakeGitHub({ "v0.1.0-beta.1": releaseOf("0.1.0-beta.1") }, null);
    for (const version of ["v0.1.0-beta.1", "0.0.9"]) {
      expect(await runUpdate({ check: true, version }, deps(gh))).toBe(1);
      expect(await runUpdate({ check: false, version }, deps(gh))).toBe(1);
    }
    expect(out.join("")).toContain("versions before 0.1.0 cannot be installed by update");
    expect(gh.urls).toEqual([]);
    expect(selfVersion()).toBe("0.3.0");
  });

  test("a downloaded pod binary without a marker is refused", async () => {
    install("0.3.0", ["0.3.0", "0.3.0"]);
    const release = releaseOf("0.4.0");
    const bad: Release = { assets: { ...release.assets, [PODS[1]]: binary(PODS[1], undefined) } };
    const gh = fakeGitHub({ "v0.4.0": bad }, "v0.4.0");
    expect(await runUpdate({ check: false }, deps(gh))).toBe(1);
    expect(out.join("")).toContain("bun-linux-arm64 carries no version marker");
    expect(podVersions()).toEqual(["0.3.0", "0.3.0"]);
    expect(temps()).toEqual([]);
  });

  test("under sudo, a created bin/ dir and the pod files go back to SUDO_UID:SUDO_GID", async () => {
    install("0.3.0", [undefined, undefined]); // no <configDir> at all yet
    const gh = fakeGitHub({ "v0.3.0": releaseOf("0.3.0") }, "v0.3.0");
    const chowned: string[] = [];
    const code = await runUpdate(
      { check: false },
      deps(gh, {
        sudoOwner: { uid: 501, gid: 20 },
        chown: async (path, uid, gid) => void chowned.push(`${path}:${uid}:${gid}`),
      }),
    );
    expect(code).toBe(0);
    expect(chowned.sort()).toEqual(
      [
        configDir,
        join(configDir, "bin"),
        join(configDir, "bin", PODS[0]),
        join(configDir, "bin", PODS[1]),
      ]
        .map((p) => `${p}:501:20`)
        .sort(),
    );
    // Not under sudo: nothing is chowned.
    chowned.length = 0;
    install("0.3.0", [undefined, "0.2.0"]);
    await runUpdate(
      { check: false },
      deps(fakeGitHub({ "v0.3.0": releaseOf("0.3.0") }, "v0.3.0"), {
        chown: async (path) => void chowned.push(path),
      }),
    );
    expect(chowned).toEqual([]);
  });

  test("source mode (dev) is refused before any request", async () => {
    install("0.3.0", ["0.3.0", "0.3.0"]);
    const gh = fakeGitHub({ "v0.4.0": releaseOf("0.4.0") }, "v0.4.0");
    expect(await runUpdate({ check: false }, deps(gh, { appVersion: "dev" }))).toBe(1);
    expect(gh.urls).toEqual([]);
    expect(out.join("")).toContain("never overwrites the `bun` executable");
    expect(await runUpdate({ check: true }, deps(gh, { appVersion: "dev" }))).toBe(1);
  });

  test("an unwritable install dir is refused BEFORE any download, with the sudo hint (D5)", async () => {
    install("0.3.0", ["0.3.0", "0.3.0"]);
    const gh = fakeGitHub({ "v0.4.0": releaseOf("0.4.0") }, "v0.4.0");
    const code = await runUpdate(
      { check: false },
      deps(gh, { isWritable: async (dir) => dir !== installDir }),
    );
    expect(code).toBe(1);
    expect(out.join("")).toContain(`sudo TENTACLE_CONFIG_DIR=${configDir} ${execPath} update`);
    expect(gh.downloads()).toEqual([]);
    expect(gh.urls.some((u) => u.endsWith("/SHA256SUMS"))).toBe(false);
    expect(selfVersion()).toBe("0.3.0");
  });

  for (const [label, break_] of [
    [
      "a checksum mismatch",
      (gh: ReturnType<typeof fakeGitHub>) =>
        gh.override.set(
          `https://github.com/${REPO}/releases/download/v0.4.0/${SELF}`,
          () => new Response("tampered"),
        ),
    ],
    [
      "a network drop mid-body",
      (gh: ReturnType<typeof fakeGitHub>) =>
        gh.override.set(
          `https://github.com/${REPO}/releases/download/v0.4.0/${PODS[1]}`,
          () =>
            new Response(
              new ReadableStream({
                pull(c) {
                  c.enqueue(new TextEncoder().encode("partial"));
                  c.error(new Error("socket hang up"));
                },
              }),
            ),
        ),
    ],
  ] as const) {
    test(`${label} leaves the old install intact and no temp behind`, async () => {
      install("0.3.0", ["0.3.0", "0.3.0"]);
      const gh = fakeGitHub({ "v0.4.0": releaseOf("0.4.0") }, "v0.4.0");
      break_(gh);
      expect(await runUpdate({ check: false }, deps(gh))).toBe(1);
      expect(selfVersion()).toBe("0.3.0");
      expect(podVersions()).toEqual(["0.3.0", "0.3.0"]);
      expect(temps()).toEqual([]);
      expect(out.join("")).toContain("[update error]");
    });
  }

  test("a new CLI whose --version is wrong (or that does not run) aborts before ANY rename", async () => {
    install("0.3.0", ["0.3.0", "0.3.0"]);
    // The release's CLI asset claims 0.3.9: an inconsistent release.
    const gh = fakeGitHub({ "v0.4.0": releaseOf("0.4.0", { selfVersion: "0.3.9" }) }, "v0.4.0");
    const renamed: string[] = [];
    const code = await runUpdate(
      { check: false },
      deps(gh, { rename: async (_f, to) => void renamed.push(to) }),
    );
    expect(code).toBe(1);
    expect(out.join("")).toContain('reports "tentacle 0.3.9", expected "tentacle 0.4.0"');
    expect(renamed).toEqual([]);
    expect(temps()).toEqual([]);

    out = [];
    const crashing = await runUpdate(
      { check: false },
      deps(fakeGitHub({ "v0.4.0": releaseOf("0.4.0") }, "v0.4.0"), {
        runVersion: async () => {
          throw new Error("exited 137: killed");
        },
        rename: async (_f, to) => void renamed.push(to),
      }),
    );
    expect(crashing).toBe(1);
    expect(out.join("")).toContain("does not run: exited 137");
    expect(renamed).toEqual([]);
    expect(temps()).toEqual([]);
  });

  test("a crash between the pod renames and the CLI rename converges on re-run", async () => {
    install("0.3.0", ["0.3.0", "0.3.0"]);
    const gh = fakeGitHub({ "v0.4.0": releaseOf("0.4.0") }, "v0.4.0");
    const { rename } = await import("node:fs/promises");
    const crash = await runUpdate(
      { check: false },
      deps(gh, {
        rename: async (from, to) => {
          if (to === execPath) {
            throw new Error("power cut");
          }
          await rename(from, to);
        },
      }),
    );
    expect(crash).toBe(1);
    expect(podVersions()).toEqual(["0.4.0", "0.4.0"]); // pods committed
    expect(selfVersion()).toBe("0.3.0"); // CLI not
    expect(temps()).toEqual([]);

    // Re-run (still the old 0.3.0 CLI): only the CLI is fetched.
    const again = fakeGitHub({ "v0.4.0": releaseOf("0.4.0") }, "v0.4.0");
    expect(await runUpdate({ check: false }, deps(again))).toBe(0);
    expect(selfVersion()).toBe("0.4.0");
    expect(again.downloads()).toEqual([
      `https://github.com/${REPO}/releases/download/v0.4.0/${SELF}`,
    ]);
  });

  test("CLI current: missing / marker-less / stale pods are filled in, the CLI untouched (D1)", async () => {
    install("0.3.0", [undefined, ""]); // x64 missing, arm64 has no marker: stale, replaced
    const before = readFileSync(execPath, "utf8");
    const gh = fakeGitHub({ "v0.3.0": releaseOf("0.3.0") }, "v0.3.0");
    expect(await runUpdate({ check: false }, deps(gh))).toBe(0);
    expect(podVersions()).toEqual(["0.3.0", "0.3.0"]);
    expect(readFileSync(execPath, "utf8")).toBe(before);
    expect(gh.downloads().some((u) => u.endsWith(SELF))).toBe(false);
    expect(out.join("")).toContain("bun-linux-arm64: unknown version → 0.3.0");
    expect(out.join("")).toContain("bun-linux-x64: missing → 0.3.0");
  });

  test("a pod asset whose marker names another version (inconsistent release) aborts, nothing renamed", async () => {
    install("0.3.0", ["0.3.0", "0.3.0"]);
    const release = releaseOf("0.4.0");
    const bad: Release = { assets: { ...release.assets, [PODS[0]]: binary(PODS[0], "0.3.5") } };
    const gh = fakeGitHub({ "v0.4.0": bad }, "v0.4.0");
    expect(await runUpdate({ check: false }, deps(gh))).toBe(1);
    expect(out.join("")).toContain("bun-linux-x64 carries version 0.3.5, not 0.4.0");
    expect(podVersions()).toEqual(["0.3.0", "0.3.0"]);
    expect(selfVersion()).toBe("0.3.0");
    expect(temps()).toEqual([]);
  });

  test("latest redirecting to /releases (a public repo with only pre-releases) is the same clear error", async () => {
    install("0.3.0", ["0.3.0", "0.3.0"]);
    const gh = fakeGitHub({}, null);
    gh.override.set(
      `https://github.com/${REPO}/releases/latest`,
      () =>
        new Response(null, {
          status: 302,
          headers: { location: `https://github.com/${REPO}/releases` },
        }),
    );
    expect(await runUpdate({ check: true }, deps(gh))).toBe(1);
    expect(out.join("")).toMatch(/no published release .*Pick a tag with --version/);
  });

  test("latest 404 (private repo / only pre-releases) is a clear error", async () => {
    install("0.3.0", ["0.3.0", "0.3.0"]);
    const gh = fakeGitHub({}, null);
    expect(await runUpdate({ check: true }, deps(gh))).toBe(1);
    expect(out.join("")).toMatch(/no published release .*not public\. Pick a tag with --version/);
  });

  test("--version of a tag that does not exist names the release", async () => {
    install("0.3.0", ["0.3.0", "0.3.0"]);
    const gh = fakeGitHub({}, null);
    expect(await runUpdate({ check: false, version: "v9.9.9" }, deps(gh))).toBe(1);
    expect(out.join("")).toMatch(
      /release v9\.9\.9 not found .*no such tag, or the repository is not public/,
    );
    expect(temps()).toEqual([]);
  });
});

describe("tentacle update — CLI wiring", () => {
  const main = (args: string[]) => {
    const proc = Bun.spawnSync(["bun", join(import.meta.dir, "../src/main.ts"), ...args], {
      env: { ...process.env, TENTACLE_CONFIG_DIR: join(tmpdir(), "tentacle-update-wiring-none") },
    });
    return { code: proc.exitCode, out: proc.stdout.toString() + proc.stderr.toString() };
  };

  test("`update` is a command (not a prompt) and refuses from source", () => {
    const r = main(["update", "--check"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("runs from source (version dev)");
  });

  test("bad arguments print the update usage", () => {
    const r = main(["update", "now"]);
    expect(r.code).toBe(1);
    expect(r.out).toContain("usage: tentacle update [--check] [--version vX.Y.Z]");
  });
});

describe("spawnVersion (the self-test)", () => {
  test("a binary that ignores SIGTERM is SIGKILLed after the grace period", async () => {
    const dir = await mkdtemp(join(tmpdir(), "tentacle-spawnv-"));
    const script = join(dir, "stubborn");
    // timeoutMs leaves the shell time to install its trap first.
    // A handler the script installs itself (Bun resets inherited "ignore"
    // dispositions in children, so `trap '' TERM` would not survive).
    writeFileSync(script, "#!/bin/sh\ntrap ':' TERM\nwhile :; do sleep 0.05; done\n");
    chmodSync(script, 0o755);
    try {
      const started = Date.now();
      await expect(spawnVersion(script, { timeoutMs: 500, graceMs: 100 })).rejects.toThrow(
        /timed out/,
      );
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      // If SIGKILL regressed, the stub would outlive the test and block the runner.
      Bun.spawnSync(["pkill", "-KILL", "-f", script]);
      await rm(dir, { recursive: true, force: true });
    }
  });
});
