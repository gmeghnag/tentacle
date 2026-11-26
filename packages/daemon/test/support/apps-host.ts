/**
 * A real `SessionHost` + `Connection` with session apps over a fake host API and
 * a manual clock (docs/feat/session-apps-publish.md).
 */
import { Agent } from "@tentacle/agent";
import {
  type AppsLink,
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import {
  type KnownSessionUpdateParams,
  type OpenResult,
  PROTOCOL_VERSION,
  type SessionUpdate,
  type SnapshotResult,
} from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../../src/connection.ts";
import { AppsService } from "../../src/session-apps.ts";
import { type AgentContext, SessionHost } from "../../src/session-host.ts";
import { type DaemonStore, SessionPersister } from "../../src/session-persister.ts";
import { Clock, DOMAIN, FakeApi, settle } from "./apps.ts";

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "ok", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

const model: ModelProvider = {
  id: "model",
  async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  },
};

export interface AppsRigOptions {
  /** `false`: a host that publishes nothing (a pod daemon). */
  readonly apps?: boolean;
  readonly store?: DaemonStore;
  readonly api?: FakeApi;
  readonly clock?: Clock;
  readonly maxDetachedSessions?: number;
}

export function appsRig(opts: AppsRigOptions = {}) {
  const api = opts.api ?? new FakeApi();
  const clock = opts.clock ?? new Clock();
  const service = new AppsService({
    configDir: "/nonexistent",
    domain: DOMAIN,
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    jitter: () => 0.5,
    api: async () => ({ ok: true, api }),
  });
  const persister = opts.store
    ? new SessionPersister({ store: opts.store, cwd: "/tmp/apps", model: "m", onError: () => {} })
    : undefined;
  const contexts: AgentContext[] = [];
  const errors: Error[] = [];
  const host = new SessionHost({
    defaultCwd: "/tmp/apps",
    now: clock.now,
    ...(persister ? { persister } : {}),
    ...(opts.apps === false ? {} : { apps: service }),
    ...(opts.maxDetachedSessions !== undefined
      ? { maxDetachedSessions: opts.maxDetachedSessions }
      : {}),
    onTurnError: (error) => errors.push(error),
    createAgent: (_cwd, context) => {
      contexts.push(context);
      const permissions = context.reuse?.permissions ?? new PermissionBroker();
      const agent = new Agent({
        model,
        tools: new ToolRegistry(),
        env,
        requestPermission: (req, options) => permissions.request(req, options),
      });
      return { agent, permissions };
    },
  });

  const connect = async (sessionId = "S") => {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const updates: KnownSessionUpdateParams[] = [];
    const client = new RpcPeer(c, {
      onNotification: (method, params) => {
        if (method === "session/update") updates.push(params as KnownSessionUpdateParams);
      },
      onRequest: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    return {
      client,
      open: (params: Record<string, unknown> = { create: true }) =>
        client.request("session/open", { sessionId, ...params }) as Promise<OpenResult>,
      prompt: (turnId: string, value = "go") =>
        client.request("session/prompt", {
          sessionId,
          turnId,
          content: [{ type: "text", text: value }],
        }),
      snapshot: () => client.request("session/snapshot", { sessionId }) as Promise<SnapshotResult>,
      request: (method: string, params: Record<string, unknown> = {}) =>
        client.request(method, { sessionId, ...params }),
      apps: () =>
        updates
          .map((u) => u.update)
          .filter((u): u is Extract<SessionUpdate, { type: "apps" }> => u.type === "apps"),
    };
  };

  /** The link the session's factory was handed (what the tools hold). */
  const link = (index = 0): AppsLink => {
    const made = contexts[index]?.apps?.();
    if (!made) throw new Error("no apps link");
    return made;
  };

  /** Present a page in session `id` and publish it through the link. */
  const publish = async (id = "S", index = 0, text = "<p>one</p>") => {
    const hosted = host.get(id);
    if (!hosted) throw new Error(`no session ${id}`);
    await hosted.artifacts.present({
      id: "page",
      bytes: new TextEncoder().encode(text),
      mimeType: "text/html",
      kind: "html",
      title: "Demo",
      callId: "c1",
    });
    const prepared = await link(index).prepare({ artifact: "page" });
    if (!prepared.ok) throw new Error(prepared.reason);
    const result = await link(index).publish(prepared);
    if (!result.ok) throw new Error(result.reason);
    await settle();
    return result.row;
  };

  return { api, clock, service, host, persister, contexts, errors, connect, link, publish };
}
