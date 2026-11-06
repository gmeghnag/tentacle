import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import type { SessionChoice } from "@tentacle/tui";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { main } from "../src/index.ts";
import { startDaemon } from "../src/serve.ts";

/**
 * `tentacle connect <url> --resume` on a terminal (docs/feat/tui-light-theme.md
 * HIGH 2, the Review's regression).
 *
 * The pre-mount picker must paint the palette `tui.theme` names. `connect` loads
 * no model config, so the setting comes from `connectTheme` — which runs INSIDE
 * `connectTui`. A picker closure in `main` that read `config` was therefore
 * outside its temporal scope: `let config` is declared BELOW the `connect`
 * branch, so the picker threw `ReferenceError` the moment the daemon had two
 * sessions to offer, and `main` printed `[connect error] …` instead of a picker.
 *
 * This runs the REAL command through `main` against a real `serve` daemon; the
 * injected picker cancels (`null`), so nothing mounts and the run exits 0.
 */

let dir: string;
let config: TentacleConfig;
let daemon: Awaited<ReturnType<typeof startDaemon>>;
const saved: Record<string, string | undefined> = {};

/** Two sessions on the daemon — `--resume` needs 2+ before it shows a picker. */
async function seedTwoSessions(url: string): Promise<void> {
  const ws = new WebSocket(url);
  const replies = new Map<number, { result?: unknown; error?: { message?: string } }>();
  ws.onmessage = (event) => {
    const msg = JSON.parse(String(event.data)) as { id?: number };
    if (typeof msg.id === "number") replies.set(msg.id, msg as never);
  };
  await new Promise<void>((resolve) => {
    ws.onopen = () => resolve();
  });
  let id = 0;
  const request = async (method: string, params: unknown): Promise<void> => {
    const n = ++id;
    ws.send(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }));
    for (let i = 0; i < 300 && !replies.has(n); i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    const reply = replies.get(n);
    if (reply?.error !== undefined) {
      throw new Error(`seed ${method}: ${reply.error.message ?? "failed"}`);
    }
  };
  await request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
  });
  await request("session/open", { create: true });
  await request("session/open", { create: true });
  ws.close();
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "connect-resume-main-"));
  saved.TENTACLE_CONFIG_DIR = process.env.TENTACLE_CONFIG_DIR;
  const configDir = join(dir, "config");
  process.env.TENTACLE_CONFIG_DIR = configDir; // never the user's config
  await mkdir(configDir, { recursive: true });
  await writeFile(join(configDir, "config.jsonc"), '{ "tui": { "theme": "light" } }\n', "utf8");
  config = await loadConfig({ cwd: dir });
  daemon = await startDaemon(config, { host: "127.0.0.1", port: 0 });
  await seedTwoSessions(daemon.url);
});

afterAll(async () => {
  await daemon.stop();
  const previous = saved.TENTACLE_CONFIG_DIR;
  if (previous === undefined) {
    // NOT `process.env.X = undefined`: that stores the STRING "undefined", which
    // then becomes a real config directory (it created one at the repo root
    // during this round). A computed key is the biome-clean way to unset it.
    const key = "TENTACLE_CONFIG_DIR";
    delete (process.env as Record<string, string | undefined>)[key];
  } else {
    process.env.TENTACLE_CONFIG_DIR = previous;
  }
  await rm(dir, { recursive: true, force: true });
});

describe("connect --resume reaches the picker (the setting, not a ReferenceError)", () => {
  test("a terminal with two sessions: the picker is asked, with the file's `light`", async () => {
    // Mutation: the picker closure reads `config` (declared below this branch) →
    // ReferenceError, `[connect error] …`, exit 1, and no pick at all.
    const out: string[] = [];
    const picks: { choices: readonly SessionChoice[]; theme: string | undefined }[] = [];
    const code = await main(["bun", "cli", "connect", daemon.url, "--resume"], {
      err: (t) => out.push(t),
      out: () => {},
      terminal: { stdin: true, stdout: true },
      // Cancelling keeps this a unit test: `connectTui` returns before mounting.
      pickSession: (async (
        choices: readonly SessionChoice[],
        options?: { readonly theme?: "auto" | "dark" | "light" },
      ) => {
        picks.push({ choices, theme: options?.theme });
        return null;
      }) as unknown as typeof import("@tentacle/tui").pickSession,
    });
    const text = out.join("");
    expect(text).not.toContain("[connect error]");
    expect(code).toBe(0);
    expect(picks).toHaveLength(1);
    expect(picks[0]?.choices.length).toBeGreaterThanOrEqual(2);
    expect(picks[0]?.theme).toBe("light");
  });
});
