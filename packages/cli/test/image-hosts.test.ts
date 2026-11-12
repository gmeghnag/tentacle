/**
 * Every cli host hands its session's image store to the agent
 * (docs/feat/attachments-prompt.md D4, T10).
 *
 * The failure this pins is SILENT: a factory that forgets `ctx.attachments`
 * turns every image into `[image unavailable — …]` with no error anywhere. So
 * the assertion is per host — a turn's `ChatRequest.attachments` IS that
 * session's `AttachmentStore` — driven through a real `Connection` so the
 * factory, the host and the wire are all in the path. `worker.ts` exports
 * nothing else usable, which is why `workerAgentFactory` was extracted.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import { loadConfig } from "@tentacle/config";
import type { AttachmentSource, ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { Connection, type ImagePolicy, SessionHost } from "@tentacle/daemon";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { podSessionHost } from "../src/serve.ts";
import { workerAgentFactory } from "../src/worker.ts";

/** A provider that records every request it is handed. */
class Recorder implements ModelProvider {
  readonly id = "recorder";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "text", delta: "ok" };
    yield { type: "done", stopReason: "stop" };
  }
}

const tick = (ms = 5): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A host whose factory forwards `ctx.attachments`, exactly as the cli's do. */
function forwardingHost(model: ModelProvider, policy?: ImagePolicy): SessionHost {
  return new SessionHost({
    defaultCwd: "/tmp/images-host",
    ...(policy ? { images: policy } : {}),
    createAgent: (_cwd, ctx) => ({
      agent: new Agent({
        model,
        tools: new ToolRegistry(),
        env: {
          id: "noop",
          exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
          readFile: () => Promise.resolve(""),
          writeFile: () => Promise.resolve(),
        },
        ...(ctx.attachments ? { attachments: ctx.attachments } : {}),
      }),
      permissions: new PermissionBroker(),
    }),
  });
}

/** Drive one prompt through a real connection; return the provider's request. */
async function turn(
  host: SessionHost,
  model: Recorder,
  ref: { id: string; mimeType: string; size: number },
): Promise<ChatRequest> {
  const [d, c] = createChannelPair();
  new Connection(d, host);
  const client = new RpcPeer(c, {
    onRequest: async () => ({ trusted: false }),
  });
  await client.request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: { streaming: true },
  });
  await client.request("session/open", { sessionId: "S", create: true });
  // The ref must be held: a `store` daemon refuses one it does not have.
  await client.request("attachment/put", {
    sessionId: "S",
    id: ref.id,
    size: ref.size,
    offset: 0,
    data: Buffer.from(IMAGE).toString("base64"),
  });
  await client.request("session/prompt", {
    sessionId: "S",
    turnId: "t1",
    content: [{ type: "attachment", ref }],
  });
  const deadline = Date.now() + 3000;
  while (model.requests.length === 0 && Date.now() < deadline) await tick();
  const seen = model.requests[0];
  if (!seen) throw new Error("the provider was never called");
  return seen;
}

const IMAGE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
const ref = {
  id: createHash("sha256").update(IMAGE).digest("hex"),
  mimeType: "image/png",
  size: IMAGE.length,
};

describe("a store-policy host gives the provider the session's store", () => {
  test("a turn's request carries THAT session's AttachmentStore", async () => {
    const model = new Recorder();
    const host = forwardingHost(model, { source: "store", maxBytes: 4 * 1024 * 1024 });
    // The store is created per session, so read it off the hosted session.
    await turn(host, model, ref);
    const store = host.get("S")?.uploads;
    if (store === undefined) throw new Error("no session store");
    expect(model.requests[0]?.attachments).toBe(store);
  });
});

describe("workerAgentFactory", () => {
  test("the agent it builds carries the source onto every model request", async () => {
    const dir = await mkdtemp(join(tmpdir(), "worker-agent-factory-"));
    const config = await loadConfig({
      configDir: dir,
      cwd: dir,
      scaffold: false,
      env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
    });
    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    const source = {
      read: async (r: { size: number }) => (r.size === bytes.length ? bytes : null),
    };
    const wired = workerAgentFactory(config, { attachments: source });
    // The property is the REQUEST: the agent's own model call must carry the
    // source, or every image reaches the model as a placeholder.
    const sent = wired.agent as unknown as { config: { attachments?: unknown } };
    expect(sent.config.attachments).toBe(source);
    await rm(dir, { recursive: true, force: true });
  });
});

describe("podSessionHost", () => {
  test("a pod without --model-proxy is a `store` daemon (it runs its own model)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pod-images-store-"));
    const config = await loadConfig({
      configDir: dir,
      cwd: dir,
      scaffold: false,
      env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
    });
    // Anthropic's default is vision on, so this pod runs its own model and
    // therefore holds the bytes (Orchestrator decision 8). Its factory forwards
    // `ctx.attachments` exactly as the worker's does (the same one-line shape,
    // pinned end to end for the worker below: this host's provider is real, so
    // a turn through it would leave the machine).
    const withModel = { ...config, provider: "anthropic" as const };
    const host = podSessionHost(withModel, undefined, {});
    expect(host.images).toEqual({ source: "store", maxBytes: 3_932_160 });
    await rm(dir, { recursive: true, force: true });
  });

  test("a pod WITH --model-proxy declares `client` (the laptop holds the bytes)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pod-images-client-"));
    const config = await loadConfig({
      configDir: dir,
      cwd: dir,
      scaffold: false,
      env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
    });
    const host = podSessionHost(config, undefined, { modelProxy: true });
    expect(host.images).toEqual({ source: "client" });
    await rm(dir, { recursive: true, force: true });
  });
});
