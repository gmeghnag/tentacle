/**
 * Project hooks in a `serve` session (docs/feat/serve-mcp.md S4, owner Q2=a).
 *
 * Today a phone turn silently never runs project hooks: the daemon asks the
 * prompting CLIENT, the phone has no `hooksTrust`, so the answer is
 * `{trusted:false}` with no message anywhere. S4 puts the decision where the
 * folder is: the serve host's OWN trust file (`<configDir>/hooks-trust.json`,
 * the file this machine's TUI writes) is checked FIRST, read-only, and only an
 * untrusted folder is asked about — of the prompting client, through the single
 * broker, never stored from there.
 *
 * Mutation: a precheck that answers "trusted" for an unknown hash → the ask test
 * records no request at all, and a phone turn would run hooks nobody trusted.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient, connectWebSocket } from "@tentacle/client";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import type { HooksTrustParams, HooksTrustResult } from "@tentacle/protocol";
import { loadConfig } from "../src/config.ts";
import { fileTrustStore } from "../src/hooks-trust.ts";
import { hooksTrustPrecheck, serveHooksTrustPrecheck } from "../src/serve-hooks-trust.ts";
import { daemonStoreDir, startDaemon } from "../src/serve.ts";

const roots: string[] = [];
const stops: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const stop of stops.splice(0).reverse()) {
    try {
      await stop();
    } catch {
      // A test that already stopped the daemon must not fail teardown.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function rig() {
  const root = mkdtempSync(join(tmpdir(), "serve-hooks-"));
  roots.push(root);
  const cwd = join(root, "proj");
  mkdirSync(cwd, { recursive: true });
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  return { root, cwd, configDir };
}

const params = (folder: string, hash: string): HooksTrustParams => ({
  sessionId: "s-1",
  folder,
  hash,
  hooks: [],
  files: [],
  canAllow: false,
});

/** A model that answers one short text, no tools. */
class QuietModel implements ModelProvider {
  readonly id = "quiet";
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "hi" };
    yield { type: "done" };
  }
}

async function serveAt(where: ReturnType<typeof rig>) {
  const config = await loadConfig({
    configDir: where.configDir,
    cwd: where.cwd,
    scaffold: false,
    env: { HOME: where.root, TENTACLE_MODEL_API_KEY: "k" },
  });
  const handle = await startDaemon(config, {
    host: "127.0.0.1",
    port: 0,
    devices: false,
    discovery: false,
    relay: { noRelay: true },
    createProvider: () => new QuietModel(),
  });
  stops.push(() => handle.stop());
  return { config, handle };
}

describe("hooksTrustPrecheck (pure)", () => {
  test("a trusted entry with the SAME hash answers trusted", () => {
    const entry = { hash: "abc", decision: "trusted" as const };
    expect(hooksTrustPrecheck(() => entry, "/p", "abc")).toBe("trusted");
  });

  test("a different hash, no entry, or a `never` decision is NOT trusted", () => {
    const trusted = { hash: "abc", decision: "trusted" as const };
    const never = { hash: "abc", decision: "never" as const };
    const get = (f: string) => (f === "/p" ? trusted : f === "/n" ? never : undefined);
    // Mutation: `hash` ignored → "trusted" for a changed hooks file.
    expect(hooksTrustPrecheck(get, "/p", "different")).toBe("ask");
    expect(hooksTrustPrecheck(get, "/unknown", "abc")).toBe("ask");
    expect(hooksTrustPrecheck(get, "/n", "abc")).toBe("ask");
  });
});

describe("the serve host's own hooks trust", () => {
  test("T13a: trusted in the host's store → the client is never asked", async () => {
    const where = rig();
    const hash = "h-1";
    fileTrustStore(where.configDir).set(where.cwd, { hash, decision: "trusted" });
    const { handle } = await serveAt(where);
    const precheck = serveHooksTrustPrecheck(where.configDir);
    // Exactly what the daemon wraps `askHooksTrust` with.
    expect(precheck(params(where.cwd, hash))).toBe(true);

    // And the RPC itself: a client whose resolver records every ask is never
    // reached, because the precheck answers first.
    const asked: HooksTrustParams[] = [];
    const client = new RemoteClient(
      await connectWebSocket(handle.url),
      new PermissionBroker(),
      undefined,
      {
        hooksTrust: async (p): Promise<HooksTrustResult> => {
          asked.push(p);
          return { trusted: false };
        },
      },
    );
    stops.push(() => client.close());
    await client.initialize();
    expect(asked).toEqual([]);
  }, 30_000);

  test("T13b: an untrusted folder is asked of the prompting client (and never stored here)", async () => {
    const where = rig();
    const marker = join(where.root, "hook-ran");
    mkdirSync(join(where.cwd, ".agents"), { recursive: true });
    writeFileSync(
      join(where.cwd, ".agents", "hooks.json"),
      `${JSON.stringify({ hooks: [{ event: "turn_start", command: `touch ${marker}` }] })}\n`,
    );
    const { handle } = await serveAt(where);
    const precheck = serveHooksTrustPrecheck(where.configDir);
    const asked: HooksTrustParams[] = [];
    const client = new RemoteClient(
      await connectWebSocket(handle.url),
      new PermissionBroker(),
      undefined,
      {
        hooksTrust: async (p): Promise<HooksTrustResult> => {
          asked.push(p);
          return { trusted: true };
        },
      },
    );
    stops.push(() => client.close());
    await client.initialize();
    const session = client.newSession();
    for await (const _event of session.send("hello")) {
      // drain the turn
    }
    // Nothing is trusted on this host, so the daemon ASKED the client (never a
    // silent decline); the client said yes and the hook ran.
    expect(asked).toHaveLength(1);
    expect(precheck(asked[0] ?? params("", ""))).toBe(false);
    expect(existsSync(marker)).toBe(true);
    // The serve host stores NOTHING from a client's answer: the next turn asks again.
    expect(fileTrustStore(where.configDir).get(where.cwd)).toBeUndefined();
  }, 30_000);
});

describe("project hooks in a serve turn", () => {
  test("T13c: an untrusted folder's hook does NOT run in a phone turn", async () => {
    const where = rig();
    const marker = join(where.root, "hook-ran");
    mkdirSync(join(where.cwd, ".agents"), { recursive: true });
    writeFileSync(
      join(where.cwd, ".agents", "hooks.json"),
      `${JSON.stringify({ hooks: [{ event: "turn_start", command: `touch ${marker}` }] })}\n`,
    );
    const { handle } = await serveAt(where);
    const asked: HooksTrustParams[] = [];
    const client = new RemoteClient(
      await connectWebSocket(handle.url),
      new PermissionBroker(),
      undefined,
      {
        hooksTrust: async (p): Promise<HooksTrustResult> => {
          asked.push(p);
          return { trusted: false };
        },
      },
    );
    stops.push(() => client.close());
    await client.initialize();
    const session = client.newSession();
    for await (const _event of session.send("hello")) {
      // drain the turn
    }
    // The daemon asked (no silent decline) and the hook did not run.
    expect(asked.length).toBeGreaterThan(0);
    expect(realpathSync(asked[0]?.folder ?? "")).toBe(realpathSync(where.cwd));
    expect(existsSync(marker)).toBe(false);
    expect(
      daemonStoreDir(
        await loadConfig({
          configDir: where.configDir,
          cwd: where.cwd,
          scaffold: false,
          env: { HOME: where.root, TENTACLE_MODEL_API_KEY: "k" },
        }),
      ),
    ).toBeTruthy();
  }, 60_000);

  test("T13d: TRUSTED in the host's store → the hook runs in a phone turn, unasked", async () => {
    const where = rig();
    const marker = join(where.root, "hook-ran");
    mkdirSync(join(where.cwd, ".agents"), { recursive: true });
    writeFileSync(
      join(where.cwd, ".agents", "hooks.json"),
      `${JSON.stringify({ hooks: [{ event: "turn_start", command: `touch ${marker}` }] })}\n`,
    );
    // Discover the folder+hash the way the agent does, then trust it here.
    const { discoverProjectHooks } = await import("@tentacle/config");
    const found = await discoverProjectHooks(where.cwd, where.root);
    const hooks = found.projectHooks;
    expect(hooks).toBeDefined();
    if (!hooks) return;
    fileTrustStore(where.configDir).set(hooks.folder, { hash: hooks.hash, decision: "trusted" });

    const { handle } = await serveAt(where);
    const asked: HooksTrustParams[] = [];
    const client = new RemoteClient(
      await connectWebSocket(handle.url),
      new PermissionBroker(),
      undefined,
      {
        hooksTrust: async (p): Promise<HooksTrustResult> => {
          asked.push(p);
          return { trusted: false };
        },
      },
    );
    stops.push(() => client.close());
    await client.initialize();
    const session = client.newSession();
    for await (const _event of session.send("hello")) {
      // drain the turn
    }
    // Mutation: no precheck → the client is asked, answers false, the hook is skipped.
    expect(asked).toEqual([]);
    expect(existsSync(marker)).toBe(true);
  }, 60_000);
});
