/**
 * docs/feat/image-view.md T7: `image_view` is offered exactly where the
 * session's write handle reaches the agent AND the model takes images — the
 * worker and `serve` — and never in a pod daemon, even one that runs its own
 * model and therefore holds its own store. The pod row runs the REAL stack
 * (`podSessionHost` → `Connection` → `RemoteClient`), so a pod factory that
 * forwarded `toolImages` would turn it red.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RemoteClient } from "@tentacle/client";
import type { ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { AttachmentStore, Connection, type SessionHost, UploadBudget } from "@tentacle/daemon";
import { HostExecution } from "@tentacle/exec";
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

/**
 * docs/feat/image-files.md T6: the image-file branch gets this model's own byte
 * cap and Q1's side bound FROM WIRING — asserted on the tool's real answer, so a
 * hard-coded constant in `createFsReadTool` turns it red.
 */
describe("fs_read on an image file: the limits come from wiring (T6)", () => {
  /** A PNG of `side`×`side`, signature + IHDR (real CRC) + IEND. */
  function png(side: number): Uint8Array {
    const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
    const be32 = (n: number) => [(n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
    const crcOf = (bytes: Uint8Array): number => {
      let c = 0xffffffff;
      for (const byte of bytes) {
        c ^= byte;
        for (let i = 0; i < 8; i += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      return (c ^ 0xffffffff) >>> 0;
    };
    const ihdr = Uint8Array.from([
      ...be32(side),
      ...be32(side),
      8,
      0,
      0,
      0,
      0, // depth 8, greyscale, deflate, filter 0, no interlace
    ]);
    const chunk = (type: string, data: Uint8Array) => {
      const body = Uint8Array.from([...ascii(type), ...data]);
      return [...be32(data.length), ...body, ...be32(crcOf(body))];
    };
    return Uint8Array.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a,
      ...chunk("IHDR", ihdr),
      ...chunk("IEND", new Uint8Array(0)),
    ]);
  }

  /** The wired `fs_read`, run on `name` in the session's cwd with a real store. */
  async function readThroughWiring(
    config: TentacleConfig,
    name: string,
    side: number,
  ): Promise<{ content: string; isError?: boolean }> {
    const bytes = png(side);
    await writeFile(join(dir, name), bytes);
    const s = store();
    const wired = workerAgentFactory(config, { attachments: s, toolImages: s });
    const tool = wired.tools.get("fs_read");
    if (tool === undefined) throw new Error("fs_read is not registered");
    return tool.execute({ path: join(dir, name) } as never, {
      sessionId: "S",
      signal: new AbortController().signal,
      env: new HostExecution({ cwd: dir }),
      images: s,
    });
  }

  test("anthropic takes 8000 px (Q1 C): a 2000 px file is read", async () => {
    const r = await readThroughWiring(vision(), "wide.png", 2000);
    expect(r.isError).toBeUndefined();
    expect(r.content).toContain("· 2000×2000 · PNG ·");
  });

  test("an OpenAI-compatible endpoint takes 1568 px: the same file is refused", async () => {
    // Mutation: `imageFileMaxEdge` → 8000 everywhere → this goes red.
    const r = await readThroughWiring(
      { ...base, provider: "openai", images: true },
      "wide.png",
      2000,
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain("2000×2000 is over the 1568 px limit for image files");
  });

  test("the model's own maxImageBytes reaches the read (mutation: hard-code MAX_IMAGE_BYTES → red)", async () => {
    const r = await readThroughWiring({ ...vision(), maxImageBytes: 20 }, "small.png", 40);
    expect(r.isError).toBe(true);
    expect(r.content).toBe("[image omitted: 45 B is over this model's 20 B limit — small.png]");
  });
});
