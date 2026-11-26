/**
 * docs/feat/session-apps-container-ports.md OD3: a shared port's secret is never
 * written where it lasts or where the model reads. One real share through a real
 * `SessionHost`, `Connection`, tool, broker and persister; every frame, model
 * request, persisted byte and log line is searched for it. Mutation: put the
 * secret link in the tool result → red.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
  type PreviewFacts,
  type PreviewResolver,
  type StreamEvent,
} from "@tentacle/core";
import { Method, PROTOCOL_VERSION, SHARE_LINK_OPTION } from "@tentacle/protocol";
import { ToolRegistry, createContainerShareTool } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { until } from "../../client/test/support/fakes.ts";
import { Connection } from "../src/connection.ts";
import { SessionHost } from "../src/session-host.ts";
import { SessionPersister } from "../src/session-persister.ts";
import { SpyDaemonStore } from "./support/daemon-store-spy.ts";
import { fakeSharer } from "./support/sharer.ts";

const FACTS: PreviewFacts = {
  engine: "docker",
  endpointLabel: "unix:///fake.sock",
  id: "d".repeat(64),
  name: "web",
  image: "nginx",
  imageId: "sha256:1",
  containerPort: 80,
  hostPort: 8080,
  hostIp: "127.0.0.1",
};
const resolver: PreviewResolver = {
  prepare: async () => ({ ok: true, facts: FACTS }),
  resolve: async () => ({ ok: true, facts: FACTS }),
};

const connections: Connection[] = [];
const spies: { mockRestore(): void }[] = [];
afterEach(() => {
  for (const c of connections.splice(0)) c.close();
  for (const s of spies.splice(0)) s.mockRestore();
});

describe("a share's secret", () => {
  test("reaches the owner's preview_link and nothing else", async () => {
    const logged: string[] = [];
    for (const method of ["log", "error", "warn", "info", "debug"] as const) {
      spies.push(
        spyOn(console, method).mockImplementation((...args: unknown[]) => {
          logged.push(args.map(String).join(" "));
        }),
      );
    }
    for (const stream of [process.stdout, process.stderr]) {
      spies.push(
        spyOn(stream, "write").mockImplementation((chunk: unknown) => {
          logged.push(String(chunk));
          return true;
        }),
      );
    }
    const requests: ChatRequest[] = [];
    const model: ModelProvider = {
      id: "model",
      async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        requests.push(structuredClone({ messages: request.messages }) as ChatRequest);
        if (requests.length === 1) {
          yield {
            type: "tool_call",
            toolCall: {
              id: "c1",
              name: "container_share",
              arguments: JSON.stringify({ container: "web", port: 80 }),
            },
          };
        } else {
          yield { type: "text", delta: "shared" };
        }
        yield { type: "done" };
      },
    };
    const store = new SpyDaemonStore();
    const sharer = fakeSharer();
    const persister = new SessionPersister({
      store,
      cwd: "/tmp/p",
      model: "m",
      onError: (error) => logged.push(String(error)),
    });
    const host = new SessionHost({
      defaultCwd: "/tmp/p",
      persister,
      previews: resolver,
      shares: sharer,
      createAgent: (_cwd, context) => {
        const permissions = context.reuse?.permissions ?? new PermissionBroker();
        const tools = new ToolRegistry().register(
          createContainerShareTool({
            link: () => context.previews?.() ?? null,
            ask: (request, options) => permissions.request(request, options),
          }),
        );
        const agent = new Agent({
          model,
          tools,
          env: {
            id: "noop",
            exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
            readFile: async () => "",
            writeFile: async () => {},
          },
          requestPermission: (req, options) => permissions.request(req, options),
        });
        return { agent, permissions };
      },
    });

    const [d, c] = createChannelPair();
    connections.push(new Connection(d, host, undefined, { principal: { kind: "token" } }));
    const frames: unknown[] = [];
    let requestId: string | undefined;
    let ended = false;
    const client = new RpcPeer(c, {
      onNotification: (_method, params) => {
        frames.push(params);
        const update = (params as { update?: { type: string; requestId?: string } }).update;
        if (update?.type === "permission_request") requestId = update.requestId;
        if (update?.type === "turn_end") ended = true;
      },
      onRequest: async (method) => {
        throw new Error(`unexpected request ${method}`);
      },
    });
    await client.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    frames.push(await client.request("session/open", { sessionId: "S", create: true }));
    const prompt = client.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "share web" }],
    });
    await until(() => requestId !== undefined);
    await client.request(Method.ResolvePermission, {
      sessionId: "S",
      requestId,
      optionId: SHARE_LINK_OPTION,
    });
    frames.push(await prompt);
    await until(() => ended);

    const secret = sharer.opened[0]?.secret ?? "";
    expect(secret.length).toBe(22);
    const snapshot = (await client.request("session/snapshot", { sessionId: "S" })) as {
      previews?: { id: string }[];
    };
    const previewId = snapshot.previews?.[0]?.id ?? "";
    expect(previewId).not.toBe("");
    const link = (await client.request(Method.PreviewLink, { sessionId: "S", previewId })) as {
      url: string;
    };
    expect(link.url).toContain(secret);
    const log = await client.request("session/log", { sessionId: "S" });
    // A stop, then the session's end: what they write is searched too.
    await client.request(Method.PreviewStop, { sessionId: "S", previewId });
    await client.request("session/close", { sessionId: "S" });
    await until(() => store.durable.get("S")?.archivedAt !== undefined);

    // The tool ran and answered the model (so the search is not vacuous).
    expect(JSON.stringify(requests[1])).toContain(sharer.url(0));
    for (const [where, value] of Object.entries({
      frames,
      snapshot,
      log,
      requests,
      files: [...store.files.values()],
      units: store.units,
      stateWrites: store.stateWrites,
      logged,
    })) {
      expect([where, JSON.stringify(value).includes(secret)]).toEqual([where, false]);
    }
  });
});
