import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../src/index.ts";
import { APP_RELEASE_VERSION } from "../src/version.ts";

/**
 * docs/feat/tui-mascot.md D5: the startup header's first line is
 * `tentacle <version>`, and the TUI package cannot import the version (the
 * dependency goes cli → tui), so every `startTui` call site must PASS it. This
 * drives the REAL `main` on the local path and reads the options it hands to its
 * `startTui` seam — the object the TUI builds the header from.
 *
 * Mutation: drop `version: APP_RELEASE_VERSION` from the `startTui` options in
 * `main.ts` → red (the header's first line falls back to `tentacle` alone).
 */

const unsubscribe = (): void => {};

/** Just enough `LocalRuntime` for the TUI's mount and teardown. */
const stubRuntime = {
  createSession: () => ({ sessionId: null }),
  jobs: { onStart: () => unsubscribe, onExit: () => unsubscribe, onUpdate: () => unsubscribe },
  link: { onLinkStatus: unsubscribe },
  mcpStatus: async () => [],
  dispose: async () => {},
  release: async () => {},
  attachTo: async () => false,
  unflushedExits: () => 0,
  announce: () => {},
};

const strayStdout: string[] = [];
const savedEnv: Record<string, string | undefined> = {};
let dir = "";

afterEach(async () => {
  // `main`'s data stream is stdout: nothing may reach it outside Ink (AGENTS §7).
  expect(strayStdout.splice(0)).toEqual([]);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  if (dir !== "") {
    await rm(dir, { recursive: true, force: true });
  }
});

/** A bare `tentacle` on a terminal: the local TUI path, with both seams faked. */
async function localTuiOptions(): Promise<Record<string, unknown>[]> {
  dir = await mkdtemp(join(tmpdir(), "tentacle-tui-version-"));
  const home = join(dir, "home");
  await mkdir(home, { recursive: true });
  for (const key of ["TENTACLE_CONFIG_DIR", "HOME"]) {
    savedEnv[key] = process.env[key];
  }
  process.env.TENTACLE_CONFIG_DIR = join(dir, "cfg");
  process.env.HOME = home;
  const seen: Record<string, unknown>[] = [];
  const err: string[] = [];
  const code = await main(["bun", "cli"], {
    out: (t) => strayStdout.push(t),
    err: (t) => err.push(t),
    terminal: { stdin: true, stdout: true },
    startTui: (async (_agent: unknown, options: Record<string, unknown>) => {
      seen.push(options);
    }) as never,
    startWorkerRuntime: (async () => stubRuntime as never) as never,
  });
  if (code !== 0) {
    throw new Error(`main exited ${code}: ${err.join("")}`);
  }
  return seen;
}

describe("the local TUI is handed this build's release version", () => {
  test("`startTui` gets `version`, so the header's first line can paint it", async () => {
    const options = await localTuiOptions();
    expect(options).toHaveLength(1);
    expect(options[0]?.version).toBe(APP_RELEASE_VERSION);
  });
});
