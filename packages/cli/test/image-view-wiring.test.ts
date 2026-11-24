/**
 * docs/feat/image-view.md T7: `image_view` is offered exactly where the
 * session's write handle reaches the agent AND the model takes images — the
 * worker and `serve` — and never in a pod daemon, even one that runs its own
 * model and therefore holds its own store. The pod row runs the REAL stack
 * (`podSessionHost` → `Connection` → `RemoteClient`), so a pod factory that
 * forwarded `toolImages` would turn it red.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient } from "@tentacle/client";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { AttachmentStore, Connection, type SessionHost, UploadBudget } from "@tentacle/daemon";
import { createChannelPair } from "@tentacle/transport";
import { type TentacleConfig, loadConfig } from "../src/config.ts";
import { createServeAgent, podSessionHost } from "../src/serve.ts";
import { createSkillScan } from "../src/wiring.ts";
import { workerAgentFactory, workerSessionHost } from "../src/worker.ts";

let dir: string;
let base: TentacleConfig;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "image-view-wiring-"));
  base = await loadConfig({
    configDir: join(dir, "config"),
    cwd: dir,
    scaffold: false,
    env: { HOME: dir, TENTACLE_MODEL_API_KEY: "k" },
  });
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const vision = (): TentacleConfig => ({ ...base, provider: "anthropic" });
const store = () => new AttachmentStore(new UploadBudget());

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

/** One session's first turn on a REAL host: the tool names the provider was handed. */
async function offered(host: SessionHost, model: Recorder): Promise<string[]> {
  const [daemonSide, clientSide] = createChannelPair();
  new Connection(daemonSide, host);
  const client = new RemoteClient(clientSide, new PermissionBroker());
  await client.initialize();
  await client.openSession(dir, undefined, "S");
  await client.prompt("S", "t1", "hello");
  const deadline = Date.now() + 3000;
  while (model.requests.length === 0 && Date.now() < deadline) {
    await tick();
  }
  return (model.requests[0]?.tools ?? []).map((tool) => tool.name);
}

describe("image_view wiring (T7)", () => {
  test("worker host with vision → offered (the store is forwarded end to end)", async () => {
    const model = new Recorder();
    const host = workerSessionHost(vision(), { version: "test", createProvider: () => model });
    expect(await offered(host, model)).toContain("image_view");
  });

  test("a pod daemon running its OWN model (it holds a store) → never offered", async () => {
    // Mutation: forward `toolImages` in `podSessionHost`'s factory → red.
    const model = new Recorder();
    const host = podSessionHost(vision(), undefined, { createProvider: () => model });
    const names = await offered(host, model);
    expect(names).not.toContain("image_view");
    expect(names).toContain("fs_read"); // non-vacuity: the registry is populated
  });

  test("worker factory: store + vision → image_view and the image fs_read variant", () => {
    const s = store();
    const wired = workerAgentFactory(vision(), { attachments: s, toolImages: s });
    expect(wired.tools.get("image_view")).toBeDefined();
    expect(wired.tools.get("fs_read")?.description).toContain("image_view");
  });

  test("serve factory: store + vision → offered", () => {
    const s = store();
    const config = vision();
    const wired = createServeAgent(config, {}, createSkillScan(config), {
      cwd: dir,
      attachments: s,
      toolImages: s,
    });
    expect(wired.tools.get("image_view")).toBeDefined();
  });

  test("images:false, or no toolImages → absent, fs_read unchanged", () => {
    const s = store();
    const off = workerAgentFactory(
      { ...vision(), images: false },
      { attachments: s, toolImages: s },
    );
    expect(off.tools.get("image_view")).toBeUndefined();
    const none = workerAgentFactory(vision(), { attachments: s });
    expect(none.tools.get("image_view")).toBeUndefined();
    expect(none.tools.get("fs_read")?.description).not.toContain("image_view");
  });
});
