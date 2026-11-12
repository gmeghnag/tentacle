/**
 * Image refs through the WHOLE pod shape (docs/feat/attachments-core.md, T13).
 *
 * Every other test proves one hop. This one proves the path a `run`/`attach`
 * actually takes, with real objects end to end: a `RemoteClient` (the laptop,
 * holding the model) ↔ a real `Connection` + `SessionHost` (the pod, running the
 * agent loop) whose model is a `ProxyModelProvider` tunnelled back to the laptop.
 *
 * The property: a `session/open{messages}` seed that carries a ref survives the
 * seed, the turn and the log — the laptop's provider receives the ref deep-equal
 * (repro *r2* was the seed stripping it) and `readBack` returns the message as a
 * CRITICAL `media_message`.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { Agent } from "@tentacle/agent";
import type {
  AttachmentRef,
  ChatMessage,
  ChatRequest,
  ModelProvider,
  StreamEvent,
} from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { Connection, ProxyModelProvider, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "a".repeat(64),
  mimeType: "image/png",
  size: 1234,
  name: "cat.png",
  ...over,
});

/** The laptop's model: records every request, answers one text round. */
class RecordingModel implements ModelProvider {
  readonly id = "recording";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "text", delta: "a cat" };
    yield { type: "done", stopReason: "stop" };
  }
}

const tick = (ms = 2): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("T13 — a seeded image survives the pod shape", () => {
  test("the laptop provider sees the ref, and the log returns a media_message", async () => {
    const model = new RecordingModel();
    const [daemonCh, laptopCh] = createChannelPair();
    // The pod's daemon: its agent's model is the tunnel back to the laptop. The
    // connection is built first, so the proxy can close over it.
    const proxyRef: { current?: ProxyModelProvider } = {};
    const host = new SessionHost({
      defaultCwd: "/pod/work",
      createAgent: () => {
        const agent = new Agent({
          model: proxyRef.current as ModelProvider,
          tools: new ToolRegistry(),
          env: {
            id: "noop",
            exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
            readFile: () => Promise.resolve(""),
            writeFile: () => Promise.resolve(),
          },
        });
        return { agent, permissions: new PermissionBroker() };
      },
    });
    const connection = new Connection(daemonCh, host);
    proxyRef.current = new ProxyModelProvider(
      (request) => connection.requestModelStream(request),
      (request, handlers) => connection.requestModelStreamChunked(request, handlers),
    );

    const laptop = new RemoteClient(laptopCh, new PermissionBroker(), model, { sha256 });
    await laptop.initialize();

    // The seed: the history a resumed session starts from, with an image on it.
    const seeded: ChatMessage[] = [
      { role: "user", content: "what is this?", attachments: [ref()] },
      { role: "assistant", content: "a cat" },
    ];
    const sessionId = await laptop.openSession("/pod/work", seeded);

    // One prompt turn, driven through the laptop's own API (a real RPC round).
    await laptop.prompt(sessionId, "t1", "and now?");
    const deadline = Date.now() + 5000;
    while (model.requests.length === 0 && Date.now() < deadline) {
      await tick(2);
    }

    // (a) The seed's ref reached the laptop's provider, deep-equal.
    const messages = model.requests[0]?.messages ?? [];
    expect(messages[0]?.attachments).toEqual([ref()]);
    // (b) The laptop's request carries only ITS OWN scoped source: a pod-named
    // ref the laptop never attached reads `null`, so the image becomes a
    // visible placeholder and no bytes leave the laptop
    // (docs/feat/attachments-prompt.md D6).
    const source = model.requests[0]?.attachments;
    if (source === undefined) throw new Error("the laptop attaches its own scoped source");
    expect(await source.read(ref())).toBeNull();

    // (c) The log returns the seeded message as a CRITICAL media entry.
    const read = await laptop.readBack(sessionId);
    expect(read.messages[0]?.attachments).toEqual([ref()]);
    const media = read.entries.filter((e) => e.type === "media_message");
    expect(media.length).toBeGreaterThan(0);
    expect(media[0]).toMatchObject({ critical: true });

    connection.close();
    laptop.close();
  });
});

describe("T9 — the whole pod path, with the laptop holding the bytes", () => {
  test("attachImage → send{attachments} → the provider gets the bytes; no bytes go to the pod", async () => {
    const bodies: Record<string, unknown>[] = [];
    // A stand-in for the real provider, implementing the SAME contract the
    // anthropic provider uses: it reads the refs' bytes through the request's
    // `attachments` source and puts the base64 on its wire. `packages/client`
    // does not depend on `packages/providers` (layering), and what this test
    // proves is that a source ARRIVES carrying the bytes — which the provider's
    // own suite covers on the other side of the seam.
    const provider: ModelProvider = {
      id: "fake-anthropic",
      async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
        const image = request.messages.flatMap((m) => m.attachments ?? [])[0];
        const data =
          image && request.attachments ? await request.attachments.read(image) : undefined;
        bodies.push({
          messages: request.messages.map((m) => [m.role, m.content]),
          image: data == null ? undefined : Buffer.from(data).toString("base64"),
        });
        yield { type: "text", delta: "a cat" };
        yield { type: "done", stopReason: "stop" };
      },
    };

    const [daemonCh, clientCh] = createChannelPair();
    // The pod: a REAL host whose agent's model is the tunnel to the laptop.
    // `images: {source: "client"}` is what a pod `--model-proxy` daemon declares.
    const proxyRef: { current?: ProxyModelProvider } = {};
    const pod = new SessionHost({
      defaultCwd: "/pod/work",
      images: { source: "client" },
      createAgent: (_cwd, ctx) => ({
        agent: new Agent({
          model: proxyRef.current as ModelProvider,
          tools: new ToolRegistry(),
          env: {
            id: "noop",
            exec: () => Promise.resolve({ stdout: "", stderr: "", exitCode: 0 }),
            readFile: () => Promise.resolve(""),
            writeFile: () => Promise.resolve(),
          },
          // The pod holds no bytes (client mode): the factory gets no source.
          ...(ctx.attachments ? { attachments: ctx.attachments } : {}),
        }),
        permissions: new PermissionBroker(),
      }),
    });
    const connection = new Connection(daemonCh, pod);
    proxyRef.current = new ProxyModelProvider(
      (request) => connection.requestModelStream(request),
      (request, handlers) => connection.requestModelStreamChunked(request, handlers),
    );

    // What the pod is ever told. Every frame toward the pod is inspected: not
    // one may carry an image's base64 (the bytes stay on the laptop).
    const towardPod: string[] = [];
    const tap: DuplexChannel = {
      send: (data: string) => {
        towardPod.push(data);
        clientCh.send(data);
      },
      close: () => clientCh.close(),
      setOnMessage: (handler: (d: string) => void) => clientCh.setOnMessage(handler),
      setOnClose: (handler: () => void) => clientCh.setOnClose(handler),
    };

    const laptop = new RemoteClient(tap, new PermissionBroker(), provider, {
      localImages: { vision: true, maxBytes: 4 * 1024 * 1024 },
      sha256: (text) => createHash("sha256").update(text).digest("hex"),
    });
    await laptop.initialize();
    const sessionId = await laptop.openSession("/pod/work");

    // A real PNG header plus bytes, so the base64 is unmistakable in the body.
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 42, 43, 44]);
    const b64 = Buffer.from(bytes).toString("base64");
    const ref = await laptop.attachImage(sessionId, bytes, {
      mimeType: "image/png",
      name: "shot.png",
    });
    expect(ref.id).toBe(createHash("sha256").update(bytes).digest("hex"));

    const session = laptop.newSession(undefined, sessionId);
    try {
      for await (const _ of session.send("what is this?", undefined, { attachments: [ref] })) {
        // drain
      }
    } catch {
      // The turn's own outcome is not the property here.
    }
    const deadline = Date.now() + 5000;
    while (bodies.length === 0 && Date.now() < deadline) await tick(5);

    // (a) The laptop's provider POSTed the image block with OUR base64.
    expect(bodies).toHaveLength(1);
    const serialised = JSON.stringify(bodies[0]);
    expect(serialised).toContain(b64);
    expect(serialised).toContain("image");
    expect(serialised).toContain("what is this?");

    // (b) The laptop held the bytes: no `attachment/put` went to the pod, and
    // no frame toward the pod carried the base64 (only the ref crossed).
    const parsed = towardPod.map((frame) => JSON.parse(frame) as { method?: string });
    expect(parsed.filter((f) => f.method === "attachment/put")).toEqual([]);
    for (const frame of towardPod) {
      expect(frame).not.toContain(b64);
    }
    // …while the ref itself did cross, so the pod's history names the image.
    expect(towardPod.some((frame) => frame.includes(ref.id))).toBe(true);

    connection.close();
    laptop.close();
  });
});
