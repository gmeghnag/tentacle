/**
 * `serve` sessions get the MCP tools configured on the serve host
 * (docs/feat/serve-mcp.md S2). Every test drives the REAL `startDaemon` with the
 * repo's stdio MCP fixture, because the failure being pinned is end to end: a
 * daemon that connects nothing reports `[]` (the Repro) and a phone session has
 * no MCP tools at all.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient, connectWebSocket } from "@tentacle/client";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { type ServeHandle, type ServeOptions, daemonStoreDir, startDaemon } from "../src/serve.ts";

const fixture = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");
/** A session's seed title: the wire's shape, not a bare string. */
const seedTitle = (text: string) => ({ text, source: "user" as const });
const stops: (() => void | Promise<void>)[] = [];
const roots: string[] = [];

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

interface Rig {
  readonly root: string;
  readonly configDir: string;
  readonly cwd: string;
}

function rig(): Rig {
  const root = mkdtempSync(join(tmpdir(), "serve-mcp-"));
  roots.push(root);
  const cwd = join(root, "proj");
  mkdirSync(cwd, { recursive: true });
  const configDir = join(root, "config");
  mkdirSync(configDir, { recursive: true });
  return { root, configDir, cwd };
}

const echoServer = (env?: Record<string, string>) => ({
  type: "stdio" as const,
  command: process.execPath,
  args: [fixture],
  ...(env ? { env } : {}),
});

async function serve(
  where: Rig,
  servers: TentacleConfig["mcpServers"],
  over: Partial<ServeOptions> & { env?: Record<string, string> } = {},
): Promise<{ config: TentacleConfig; handle: ServeHandle; notices: string[] }> {
  const { env, ...optionOverrides } = over;
  const config = {
    ...(await loadConfig({
      configDir: where.configDir,
      cwd: where.cwd,
      scaffold: false,
      env: { HOME: where.root, TENTACLE_MODEL_API_KEY: "k", ...env },
    })),
    mcpServers: servers,
  };
  const notices: string[] = [];
  const handle = await startDaemon(config, {
    host: "127.0.0.1",
    port: 0,
    devices: false,
    discovery: false,
    relay: { noRelay: true },
    onNotice: (line) => notices.push(line),
    ...optionOverrides,
  });
  stops.push(() => handle.stop());
  return { config, handle, notices };
}

/** A `RemoteClient` on `handle`, initialized; closed at teardown. */
async function client(handle: ServeHandle, broker = new PermissionBroker(), token?: string) {
  // A token daemon refuses an anonymous upgrade: the same token the caller
  // started it with goes on the socket (query + header).
  const opts = token === undefined ? {} : { token };
  const created = new RemoteClient(await connectWebSocket(handle.url, opts), broker);
  stops.push(() => created.close());
  await created.initialize();
  return created;
}

async function until(cond: () => Promise<boolean> | boolean, ms = 15_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > deadline) throw new Error(`timed out: ${cond.toString()}`);
    await Bun.sleep(20);
  }
}

/** Wait for the daemon's background MCP connect to settle (`connecting` gone). */
async function settledStates(remote: RemoteClient): Promise<string[]> {
  let states: string[] = [];
  await until(async () => {
    states = (await remote.mcpStatus()).map((s) => s.state);
    return !states.includes("connecting");
  });
  return states;
}

const pidAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const pidFrom = async (file: string): Promise<number> => {
  await until(() => existsSync(file));
  return Number(readFileSync(file, "utf8").trim());
};

/** The model a test scripts: one tool call per stream; `null` is a text-only stream. */
class ScriptedModel implements ModelProvider {
  readonly id = "scripted";
  readonly requests: ChatRequest[] = [];
  constructor(private readonly calls: (string | null)[]) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    const next = this.calls.shift();
    if (next === undefined || next === null) {
      yield { type: "text", delta: "done" };
      yield { type: "done" };
      return;
    }
    yield {
      type: "tool_call",
      toolCall: { id: `c${this.requests.length}`, name: next, arguments: "{}" },
    };
    yield { type: "done" };
  }
}

/** Send `text` on `session` and settle, collecting the turn's text deltas. */
async function sendAndSettle(
  session: ReturnType<RemoteClient["newSession"]>,
  text: string,
): Promise<{ texts: string[]; error: string | null }> {
  const texts: string[] = [];
  try {
    for await (const event of session.send(text)) {
      if (event.type === "text") texts.push(event.delta);
    }
    return { texts, error: null };
  } catch (error) {
    return { texts, error: error instanceof Error ? error.message : String(error) };
  }
}

describe("serve sessions get the host's MCP servers", () => {
  test("T5: mcp/status reports each configured server's live state (was [])", async () => {
    const where = rig();
    const { handle } = await serve(where, {
      echo: echoServer(),
      missing: { type: "stdio", command: join(where.root, "no-such-mcp-server") },
    });
    const remote = await client(handle);
    // Mutation: no hub in `startDaemon`/`reloadedHost` → `[]` (the Repro).
    await settledStates(remote);
    const servers = await remote.mcpStatus();
    expect(servers.map((s) => [s.name, s.state, s.tools, s.moreTools])).toEqual([
      ["echo", "connected", ["echo"], 0],
      ["missing", "failed", [], 0],
    ]);
    expect(servers[1]?.error).toBeTruthy();
  }, 30_000);

  test("T5b: a failed server is one notice line, never a silent skip", async () => {
    const where = rig();
    const { handle, notices } = await serve(where, {
      echo: echoServer(),
      missing: { type: "stdio", command: join(where.root, "no-such-mcp-server") },
    });
    const remote = await client(handle);
    await settledStates(remote);
    await until(() => notices.some((line) => line.includes("missing")));
    const failures = notices.filter((line) => line.includes('mcp server "missing"'));
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("failed to connect");
  }, 30_000);

  test("T6: an MCP tool stays gated — deny never reaches the server, allow does", async () => {
    const where = rig();
    const callLog = join(where.root, "calls.log");
    const denier = new PermissionBroker(() => Promise.resolve({ allowed: false }));
    const model = new ScriptedModel(["mcp__echo__echo"]);
    const first = await serve(
      where,
      { echo: echoServer({ MCP_CALL_LOG: callLog }) },
      { createProvider: () => model },
    );
    const remote = await client(first.handle, denier);
    await settledStates(remote);
    const session = remote.newSession(undefined, undefined, seedTitle("S"));
    const turn = await sendAndSettle(session, "call it");
    // Mutation: `permission: "none"` in `tool-adapter.ts:79` → this log exists.
    expect(existsSync(callLog)).toBe(false);
    expect(turn.error).toBeNull();
    // The model was told the call was denied, so the gate really ran.
    const told = JSON.stringify(model.requests.at(-1)?.messages ?? []);
    expect(told.toLowerCase()).toContain("denied");
    // The FIRST daemon's store must be released before the second one starts.
    await first.handle.stop();

    // The ALLOW case: the same script, one approving broker → exactly one call.
    const caller = new ScriptedModel(["mcp__echo__echo"]);
    const second = await serve(
      where,
      { echo: echoServer({ MCP_CALL_LOG: callLog }) },
      { createProvider: () => caller },
    );
    const remote2 = await client(
      second.handle,
      new PermissionBroker(() => Promise.resolve({ allowed: true })),
    );
    await settledStates(remote2);
    const session2 = remote2.newSession(undefined, undefined, seedTitle("S"));
    await sendAndSettle(session2, "call it");
    await until(() => existsSync(callLog));
    expect(readFileSync(callLog, "utf8").trim().split("\n")).toHaveLength(1);
    expect(caller.requests.length).toBeGreaterThan(1);
  }, 60_000);

  test("T7: stop() kills the server processes", async () => {
    const where = rig();
    const pidFile = join(where.root, "echo.pid");
    const { handle } = await serve(where, { echo: echoServer({ MCP_PID_FILE: pidFile }) });
    const remote = await client(handle);
    await settledStates(remote);
    const pid = await pidFrom(pidFile);
    expect(pidAlive(pid)).toBe(true);
    // Mutation: drop `mcpHub.dispose()` from `release` → the pid survives.
    await handle.stop();
    await until(() => !pidAlive(pid));
  }, 30_000);

  test("T8: a stop DURING a slow init still kills the server at settle", async () => {
    const where = rig();
    const pidFile = join(where.root, "slow.pid");
    const { handle } = await serve(where, {
      slow: echoServer({ MCP_PID_FILE: pidFile, MCP_INIT_DELAY_MS: "800" }),
    });
    // No client on this daemon: the connect is in flight behind the handshake
    // delay (which is the point — T8 stops the daemon inside that window).
    const pid = await pidFrom(pidFile);
    expect(pidAlive(pid)).toBe(true);
    await handle.stop();
    // The dispose landed before the settle: the connection arrives later and is
    // closed then (mutation: no `disposed` handling at settle → it survives).
    await until(() => !pidAlive(pid), 20_000);
  }, 30_000);

  test("T9: a RESTORED session gets the MCP tools once the server settles", async () => {
    const where = rig();
    const slow = () => echoServer({ MCP_INIT_DELAY_MS: "3000" });
    // First run: a session with one committed round, then the daemon stops.
    const first = await serve(
      where,
      { echo: slow() },
      { createProvider: () => new ScriptedModel([]) },
    );
    const remote = await client(first.handle);
    const session = remote.newSession(undefined, undefined, seedTitle("Slow"));
    await sendAndSettle(session, "hello");
    const id = session.sessionId;
    expect(id).not.toBeNull();
    if (id === null) return;
    await first.handle.stop();
    const storeDir = daemonStoreDir(first.config);
    await until(() => existsSync(join(storeDir, `${id}.jsonl`)));

    // Second run: the record is RESTORED while the server is still handshaking
    // (3 s), so its agent's registry is built before the connect settles. The
    // `pending` flush must still put the tool into it: a turn on the restored
    // session names `mcp__echo__echo` in its request, or the tools were lost.
    const model = new ScriptedModel([]);
    const second = await serve(where, { echo: slow() }, { createProvider: () => model });
    const restored = await client(second.handle);
    expect((await restored.sessionList()).sessions.map((s) => s.sessionId)).toContain(id);
    await settledStates(restored);
    // The restored session is attached (it was built with its OWN agent, before
    // the connect settled) and a turn on it must see the MCP tool.
    const back = restored.newSession(undefined, id, seedTitle("Slow"));
    await sendAndSettle(back, "again");
    const names = (model.requests.at(-1)?.tools ?? []).map((tool) => tool.name);
    // Mutation: no `mcpHub.onBuilt(wired.tools)` in `createServeAgent` → absent.
    expect(names).toContain("mcp__echo__echo");
    // The history is the round it ran plus this one.
    expect((await restored.snapshot(id)).length).toBeGreaterThan(1);
  }, 60_000);

  test("T10: 80 stderr lines → 50 notices + one suppression line", async () => {
    const where = rig();
    const { handle, notices } = await serve(where, {
      echo: echoServer({ MCP_STDERR_LINES: "80" }),
    });
    await until(() => notices.some((line) => line.includes("suppressed")));
    const forEcho = notices.filter((line) => line.startsWith("mcp echo:"));
    // Mutation: remove the cap in `capStderr` → 80 lines, no suppression line.
    expect(forEcho).toHaveLength(51);
    expect(forEcho.at(-1)).toBe("mcp echo: further stderr suppressed");
  }, 30_000);

  test("T11: the daemon's own token never reaches an MCP server", async () => {
    const where = rig();
    const callLog = join(where.root, "env.log");
    const model = new ScriptedModel(["mcp__echo__echo"]);
    // The serve token really is in the daemon PROCESS's env (that is what `serve`
    // validates an inbound connection against), so the fixture's env dump is a
    // true witness: `transport.ts` scrubs the child env through `scrubSensitiveEnv`,
    // and `TOKEN` matches its secret pattern.
    const key = "TENTACLE_REMOTE_TOKEN";
    const saved = process.env[key];
    process.env[key] = "s3cret-serve-token";
    stops.push(() => {
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    });
    const serving = await serve(
      where,
      { echo: echoServer({ MCP_CALL_LOG: callLog }) },
      { createProvider: () => model, token: "s3cret-serve-token" },
    );
    const remote = await client(
      serving.handle,
      new PermissionBroker(() => Promise.resolve({ allowed: true })),
      "s3cret-serve-token",
    );
    await settledStates(remote);
    const session = remote.newSession(undefined, undefined, seedTitle("S"));
    await sendAndSettle(session, "call it");
    await until(() => existsSync(callLog));
    const raw = readFileSync(callLog, "utf8");
    const entry = JSON.parse(raw.trim().split("\n")[0] ?? "{}") as { envKeys?: string[] };
    // `transport.ts` scrubs the child env through `scrubSensitiveEnv`.
    expect(entry.envKeys).toBeDefined();
    expect(entry.envKeys).not.toContain("TENTACLE_REMOTE_TOKEN");
    expect(raw).not.toContain("s3cret-serve-token");
  }, 60_000);

  test("T12: a crashed server respawns and the SAME session's tool still works", async () => {
    const where = rig();
    const pidFile = join(where.root, "crash.pid");
    const callLog = join(where.root, "crash-calls.log");
    // The model: kill the tool's server with a call that never gets an answer,
    // then call the SAME tool again once the supervisor has respawned it.
    const model = new ScriptedModel(["mcp__echo__echo", null, "mcp__echo__echo", null]);
    const { handle, notices } = await serve(
      where,
      {
        echo: echoServer({
          MCP_PID_FILE: pidFile,
          MCP_CALL_LOG: callLog,
          MCP_CRASH_ON_CALL_ONCE: "1",
        }),
      },
      { createProvider: () => model },
    );
    const remote = await client(
      handle,
      new PermissionBroker(() => Promise.resolve({ allowed: true })),
    );
    await settledStates(remote);
    const firstPid = await pidFrom(pidFile);
    const session = remote.newSession(undefined, undefined, seedTitle("S"));
    // Turn 1: the server dies mid-call (the model gets a tool error, honestly).
    await sendAndSettle(session, "call it");
    // Poll, never sample: the child's death and its REAPING are separate events.
    // The transport settles the turn on the pipe close, at which point the pid
    // still answers `kill(pid, 0)` as a zombie (`ps` says `ZN`) until the
    // parent's SIGCHLD handling reaps it — a single sample is a race, not a sync
    // point (AGENTS §9).
    await until(() => !pidAlive(firstPid), 20_000);
    // Mutation: no supervision → the server stays `closed` and no new pid appears.
    await until(() => notices.some((line) => line.includes("restarting")), 20_000);
    await until(() => {
      if (!existsSync(pidFile)) return true;
      return Number(readFileSync(pidFile, "utf8").trim()) !== firstPid;
    }, 30_000);
    await until(() => notices.some((line) => line.includes("reconnected")), 30_000);
    const secondPid = Number(readFileSync(pidFile, "utf8").trim());
    expect(secondPid).not.toBe(firstPid);
    expect(pidAlive(secondPid)).toBe(true);
    // Turn 2 on the SAME session: the tool works again, through the respawn —
    // that is the "stable tools" property S3 exists for.
    await sendAndSettle(session, "call it again");
    await until(() => existsSync(callLog));
    expect(readFileSync(callLog, "utf8").trim().split("\n")).toHaveLength(1);
    const servers = await remote.mcpStatus();
    expect(servers[0]?.state).toBe("connected");
    await handle.stop();
    await until(() => !pidAlive(secondPid), 20_000);
  }, 90_000);
});
