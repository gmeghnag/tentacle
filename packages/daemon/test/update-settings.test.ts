/**
 * `session/update_settings` on the daemon (docs/feat/session-settings-apply.md):
 * between turns, the session's agent is rebuilt by the same factory from the
 * new settings and swapped in one synchronous stretch; the conversation, the
 * broker, the jobs (and their pending exits) and the approvals carry over.
 */
import { describe, expect, test } from "bun:test";
import { Agent, SessionGrants } from "@tentacle/agent";
import {
  type BackgroundJob,
  type ChatRequest,
  type ExecutionEnvironment,
  type JobController,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import {
  type KnownSessionUpdateParams,
  type OpenResult,
  PROTOCOL_VERSION,
  type SessionSettings,
  type UpdateSettingsResult,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { DomainErrorCode, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { type AgentContext, SessionHost } from "../src/session-host.ts";

const INIT = { protocolVersion: PROTOCOL_VERSION, clientCapabilities: { streaming: true } };
const tick = (ms = 2): Promise<void> => new Promise((r) => setTimeout(r, ms));

const env: ExecutionEnvironment = {
  id: "noop",
  exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: () => Promise.resolve(""),
  writeFile: () => Promise.resolve(),
};

/** Records each request; while `gate` is set, holds the stream until it opens. */
class Recording implements ModelProvider {
  readonly id = "recording";
  readonly requests: ChatRequest[] = [];
  constructor(private readonly gate: { wait: Promise<void> | null }) {}
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    if (this.gate.wait) {
      await this.gate.wait;
    }
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
}

function controllableJobs(): JobController & {
  fireExit(job: BackgroundJob): void;
  listeners(): number;
  disposed: boolean;
} {
  const listeners = new Set<(job: BackgroundJob) => void>();
  return {
    disposed: false,
    fireExit(job) {
      for (const l of [...listeners]) l(job);
    },
    listeners: () => listeners.size,
    start: () => ({ id: "bg-1", command: "x", startedAt: 0, status: "running", exitCode: null }),
    read: () => undefined,
    kill: () => false,
    list: () => [],
    dispose() {
      this.disposed = true;
    },
    onStart: () => () => {},
    onExit(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

interface Built {
  readonly context: AgentContext;
  readonly model: Recording;
  readonly permissions: PermissionBroker;
  readonly grants: SessionGrants;
  readonly jobs: JobController;
}

function harness(
  opts: {
    /** Answer a settings report (a proxy daemon). Default true. */
    honour?: boolean;
    /** The n-th factory call (1-based) throws. */
    throwOn?: number;
    /** Ignore `reuse` (a factory that builds its own broker and jobs). */
    ignoreReuse?: boolean;
  } = {},
) {
  const gate: { wait: Promise<void> | null } = { wait: null };
  const jobs = controllableJobs();
  const built: Built[] = [];
  const host = new SessionHost({
    defaultCwd: "/tmp/w",
    createAgent: (_cwd, context) => {
      if (opts.throwOn === built.length + 1) {
        built.push({
          context,
          model: new Recording(gate),
          permissions: new PermissionBroker(),
          grants: new SessionGrants(),
          jobs,
        });
        throw new Error("bad config");
      }
      const reuse = opts.ignoreReuse ? undefined : context.reuse;
      const model = new Recording(gate);
      const ownJobs = reuse?.jobs ?? (built.length === 0 ? jobs : controllableJobs());
      const grants = reuse?.grants ?? new SessionGrants();
      const permissions = reuse?.permissions ?? new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry(),
        env,
        jobs: ownJobs,
        grants,
        systemPrompt: `prompt ${context.settings?.maxIterations ?? "-"}`,
      });
      built.push({ context, model, permissions, grants, jobs: ownJobs });
      return {
        agent,
        permissions,
        jobs: ownJobs,
        grants,
        ...(opts.honour !== false && context.settings
          ? { settingsReport: { carried: context.settings, overridden: {} } }
          : {}),
      };
    },
  });
  const peer = () => {
    const [daemonCh, clientCh] = createChannelPair();
    const connection = new Connection(daemonCh, host);
    const updates: KnownSessionUpdateParams[] = [];
    const client = new RpcPeer(clientCh, {
      onNotification: (method, params) => {
        if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
      },
    });
    return { client, connection, updates };
  };
  return { gate, jobs, built, host, peer };
}

async function opened(
  client: RpcPeer,
  settings: SessionSettings = { maxIterations: 1 },
): Promise<OpenResult> {
  await client.request("initialize", INIT);
  return (await client.request("session/open", {
    sessionId: "S",
    create: true,
    settings,
  })) as OpenResult;
}

const apply = (client: RpcPeer, settings: SessionSettings, id = "a1") =>
  client.request("session/update_settings", {
    sessionId: "S",
    id,
    settings,
  }) as Promise<UpdateSettingsResult>;

async function turn(
  client: RpcPeer,
  updates: KnownSessionUpdateParams[],
  turnId: string,
): Promise<void> {
  await client.request("session/prompt", {
    sessionId: "S",
    turnId,
    content: [{ type: "text", text: `say ${turnId}` }],
  });
  for (
    let i = 0;
    i < 500 && !updates.some((u) => u.update.type === "turn_end" && u.update.turnId === turnId);
    i++
  ) {
    await tick();
  }
}

const codeOf = (error: unknown) => (error instanceof RpcError ? error.code : error);
const settingsUpdates = (updates: KnownSessionUpdateParams[]) =>
  updates.filter((u) => u.update.type === "session_settings");

describe("session/update_settings: the agent swap (docs/feat/session-settings-apply.md)", () => {
  test("T2 the next turn runs on the agent built from the NEW settings, with the session's broker", async () => {
    const { built, peer } = harness();
    const { client, updates } = peer();
    await opened(client);
    const result = await apply(client, { maxIterations: 3 });
    expect(result).toEqual({
      applied: true,
      settings: { carried: { maxIterations: 3 }, overridden: {} },
    });
    expect(built).toHaveLength(2);
    expect(built[1]?.context.settings).toEqual({ maxIterations: 3 });
    expect(built[0]?.permissions).toBeDefined();
    expect(built[1]?.context.reuse?.permissions === built[0]?.permissions).toBe(true);
    await turn(client, updates, "t1");
    expect(built[0]?.model.requests).toHaveLength(0);
    expect(built[1]?.model.requests).toHaveLength(1);
    // The system head was recomposed in place.
    expect(built[1]?.model.requests[0]?.messages[0]).toEqual({
      role: "system",
      content: "prompt 3",
    });
  });

  test("T3 the session's approvals and jobs are handed to the new agent", async () => {
    const { built, jobs, peer } = harness();
    const { client } = peer();
    await opened(client);
    await apply(client, { maxIterations: 3 });
    expect(built[0]?.grants).toBeDefined();
    expect(built[1]?.context.reuse?.grants === built[0]?.grants).toBe(true);
    expect(built[1]?.context.reuse?.jobs).toBe(jobs);
    // A second apply hands over the same ones again.
    await apply(client, { maxIterations: 4 }, "a2");
    expect(built[2]?.context.reuse?.grants === built[0]?.grants).toBe(true);
  });

  test("T4 a job exit seen while idle reaches the new agent's turn once; the old agent left the jobs", async () => {
    const { built, jobs, peer } = harness();
    const { client, updates } = peer();
    await opened(client);
    // HostedSession's own live stream + the first agent's collector.
    expect(jobs.listeners()).toBe(2);
    jobs.fireExit({ id: "bg-7", command: "srv", startedAt: 0, status: "exited", exitCode: 0 });
    await apply(client, { maxIterations: 3 });
    expect(jobs.listeners()).toBe(2);
    await turn(client, updates, "t1");
    const notes = (built[1]?.model.requests[0]?.messages ?? []).filter(
      (m) => typeof m.content === "string" && m.content.includes("bg-7"),
    );
    expect(notes).toHaveLength(1);
  });

  test("T5 a factory that throws leaves the old agent, its report and no update", async () => {
    const { built, peer } = harness({ throwOn: 2 });
    const { client, updates } = peer();
    await opened(client);
    await expect(apply(client, { maxIterations: 3 })).rejects.toBeInstanceOf(RpcError);
    await turn(client, updates, "t1");
    expect(built[0]?.model.requests).toHaveLength(1);
    expect(settingsUpdates(updates)).toHaveLength(0);
    const again = peer();
    const reopened = await opened(again.client);
    expect(reopened.settings?.carried).toEqual({ maxIterations: 1 });
  });

  test("T6 a running turn refuses with TurnInProgress, the factory is not called", async () => {
    const { built, gate, peer } = harness();
    const { client, updates } = peer();
    await opened(client);
    let open = (): void => {};
    gate.wait = new Promise((r) => {
      open = r;
    });
    await client.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "hold" }],
    });
    const error = await apply(client, { maxIterations: 3 }).catch((e: unknown) => e);
    expect(codeOf(error)).toBe(DomainErrorCode.TurnInProgress);
    expect(built).toHaveLength(1);
    expect(settingsUpdates(updates)).toHaveLength(0);
    gate.wait = null;
    open();
  });

  test("T6 a running compaction refuses with CompactInProgress", async () => {
    const { built, gate, peer } = harness();
    const { client, updates } = peer();
    await opened(client);
    await turn(client, updates, "t0");
    let open = (): void => {};
    gate.wait = new Promise((r) => {
      open = r;
    });
    const compacting = client.request("session/compact", { sessionId: "S" }).catch(() => null);
    await tick();
    const error = await apply(client, { maxIterations: 3 }).catch((e: unknown) => e);
    expect(codeOf(error)).toBe(DomainErrorCode.CompactInProgress);
    expect(built).toHaveLength(1);
    gate.wait = null;
    open();
    await compacting;
  });

  test("T8 the session's report is replaced: a later attach sees the new values", async () => {
    const { peer } = harness();
    const { client } = peer();
    await opened(client);
    await apply(client, { maxIterations: 3 });
    const other = peer();
    const attached = await opened(other.client, { maxIterations: 99 });
    expect(attached.created).toBe(false);
    expect(attached.settings).toEqual({ carried: { maxIterations: 3 }, overridden: {} });
  });

  test("T9 a daemon that decides by its own config answers applied:false and keeps the old agent", async () => {
    const { built, jobs, peer } = harness({ honour: false });
    const { client, updates } = peer();
    await opened(client);
    expect(await apply(client, { maxIterations: 3 })).toEqual({ applied: false });
    // The throw-away agent left the shared jobs.
    expect(jobs.listeners()).toBe(2);
    await turn(client, updates, "t1");
    expect(built[0]?.model.requests).toHaveLength(1);
    expect(built[1]?.model.requests).toHaveLength(0);
    expect(settingsUpdates(updates)).toHaveLength(0);
  });

  test("a factory that ignores the reuse is refused: no swap, its own jobs disposed", async () => {
    const { built, peer } = harness({ ignoreReuse: true });
    const { client, updates } = peer();
    await opened(client);
    const error = await apply(client, { maxIterations: 3 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RpcError);
    const foreign = built[1]?.jobs as ReturnType<typeof controllableJobs> | undefined;
    expect(foreign?.disposed).toBe(true);
    await turn(client, updates, "t1");
    expect(built[0]?.model.requests).toHaveLength(1);
  });

  test("T10 apply then prompt in the same tick: the turn runs on the new agent", async () => {
    const { built, peer } = harness();
    const { client, updates } = peer();
    await opened(client);
    const applying = apply(client, { maxIterations: 3 });
    const prompting = turn(client, updates, "t1");
    await Promise.all([applying, prompting]);
    expect(built[0]?.model.requests).toHaveLength(0);
    expect(built[1]?.model.requests).toHaveLength(1);
  });

  test("T10 prompt then apply in the same tick: the apply is refused, the turn is on the old agent", async () => {
    const { built, gate, peer } = harness();
    const { client, updates } = peer();
    await opened(client);
    let open = (): void => {};
    gate.wait = new Promise((r) => {
      open = r;
    });
    const prompting = client.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "x" }],
    });
    const applying = apply(client, { maxIterations: 3 }).catch((e: unknown) => e);
    await prompting;
    expect(codeOf(await applying)).toBe(DomainErrorCode.TurnInProgress);
    gate.wait = null;
    open();
    for (let i = 0; i < 500 && !updates.some((u) => u.update.type === "turn_end"); i++) {
      await tick();
    }
    expect(built[0]?.model.requests).toHaveLength(1);
    expect(built).toHaveLength(1);
  });

  test("T20 every attached client gets one display session_settings update, with the applier's id", async () => {
    const { peer } = harness();
    const a = peer();
    const b = peer();
    await opened(a.client);
    await opened(b.client);
    await apply(a.client, { maxIterations: 3 }, "mine-1");
    await tick();
    for (const side of [a, b]) {
      const got = settingsUpdates(side.updates);
      expect(got).toHaveLength(1);
      expect(got[0]?.update).toEqual({
        type: "session_settings",
        settings: { carried: { maxIterations: 3 }, overridden: {} },
        id: "mine-1",
      });
      expect(got[0]?.mandatory).toBeUndefined();
    }
  });

  test("a session this connection did not open → UnknownSession; bad settings → InvalidParams", async () => {
    const { peer, built } = harness();
    const { client } = peer();
    await client.request("initialize", INIT);
    const unknown = await apply(client, { maxIterations: 3 }).catch((e: unknown) => e);
    expect(codeOf(unknown)).toBe(DomainErrorCode.UnknownSession);
    await client.request("session/open", { sessionId: "S", create: true, settings: {} });
    const invalid = await client
      .request("session/update_settings", {
        sessionId: "S",
        id: "x",
        settings: { maxIterations: 0 },
      })
      .catch((e: unknown) => e);
    expect(invalid).toBeInstanceOf(RpcError);
    expect(built).toHaveLength(1);
  });
});
