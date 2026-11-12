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
import { createChannelPair } from "@tentacle/transport";
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
    // (b) The laptop's request carries NO source: a pod's refs read nothing here.
    expect(model.requests[0]).not.toHaveProperty("attachments");

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
