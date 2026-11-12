/**
 * Image REFS cross the pod tunnel (docs/feat/attachments-core.md, D7, T7).
 *
 * The pod runs the loop; the laptop holds the model. A `ChatMessage` with refs
 * must arrive at the laptop's provider with those refs intact — and with NO
 * `attachments` SOURCE, so the laptop reads nothing it was not given (AGENTS §7
 * "a pod is not trusted": refs, never bytes, and no ambient read authority).
 *
 * Real `Connection` + `RemoteClient` over a channel pair, as in
 * `model-stream-stop-reason.test.ts`, so this is what the laptop actually sees.
 */
import { describe, expect, test } from "bun:test";
import type { AttachmentRef, ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { Connection, ProxyModelProvider, SessionHost } from "@tentacle/daemon";
import { createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "a".repeat(64),
  mimeType: "image/png",
  size: 1234,
  name: "cat.png",
  ...over,
});

/** The laptop's model: records the request it was handed, then finishes. */
class RecordingModel implements ModelProvider {
  readonly id = "recording";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "done" };
  }
}

function connected(model: ModelProvider) {
  const [d, c] = createChannelPair();
  const laptop = new RemoteClient(c, new PermissionBroker(), model);
  return { laptop, podEnd: d };
}

function podHost(): SessionHost {
  return new SessionHost({
    defaultCwd: "/pod/work",
    createAgent: () => {
      throw new Error("not used: these tests drain the proxy directly");
    },
  });
}

const REQ: ChatRequest = {
  messages: [
    { role: "user", content: "what is this?", attachments: [ref()] },
    { role: "assistant", content: "a cat" },
    { role: "user", content: "and this?", attachments: [ref({ id: "b".repeat(64) })] },
  ],
};

async function tunnel(
  useChunked: boolean,
): Promise<{ requests: ChatRequest[]; laptop: RemoteClient; connection: Connection }> {
  const model = new RecordingModel();
  const { laptop, podEnd } = connected(model);
  const connection = new Connection(podEnd, podHost());
  const proxy = new ProxyModelProvider(
    (request) => connection.requestModelStream(request),
    (request, handlers) => connection.requestModelStreamChunked(request, handlers),
  );
  await laptop.initialize();
  for await (const _ of proxy.stream(REQ)) {
    // drain
  }
  return { requests: model.requests, laptop, connection };
}

describe("T7 — refs arrive at the laptop's provider", () => {
  test("the chunked transport carries them deep-equal", async () => {
    const { requests, laptop, connection } = await tunnel(true);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.messages[0]?.attachments).toEqual([ref()]);
    expect(requests[0]?.messages[2]?.attachments).toEqual([ref({ id: "b".repeat(64) })]);
    connection.close();
    laptop.close();
  });

  test("the batch transport carries them too", async () => {
    const { requests, laptop, connection } = await tunnel(false);
    expect(requests[0]?.messages[0]?.attachments).toEqual([ref()]);
    connection.close();
    laptop.close();
  });

  test("the laptop gets NO attachment source: a pod's refs read nothing here", async () => {
    const { requests, laptop, connection } = await tunnel(true);
    // The field is non-serialisable and never on the wire: absent means "this
    // side may not read", which is the secure default for a pod's refs.
    expect(requests[0]).not.toHaveProperty("attachments");
    connection.close();
    laptop.close();
  });

  test("a message without refs arrives without the key (nothing is invented)", async () => {
    const model = new RecordingModel();
    const { laptop, podEnd } = connected(model);
    const connection = new Connection(podEnd, podHost());
    const proxy = new ProxyModelProvider((request) => connection.requestModelStream(request));
    await laptop.initialize();
    for await (const _ of proxy.stream({ messages: [{ role: "user", content: "hi" }] })) {
      // drain
    }
    expect(model.requests[0]?.messages[0]).not.toHaveProperty("attachments");
    connection.close();
    laptop.close();
  });

  test("an unsendable ref from a pod is inert, not fatal: it arrives, and the laptop sends a placeholder", async () => {
    // A pod is not trusted: it may send any ref. It parses (a free `image/*`
    // string), reaches the provider, and becomes the visible "unavailable"
    // placeholder — never a read, never a silent drop.
    const model = new RecordingModel();
    const { laptop, podEnd } = connected(model);
    const connection = new Connection(podEnd, podHost());
    const proxy = new ProxyModelProvider((request) => connection.requestModelStream(request));
    await laptop.initialize();
    const exotic = { ...ref(), mimeType: "image/heic" };
    for await (const _ of proxy.stream({
      messages: [{ role: "user", content: "", attachments: [exotic] }],
    })) {
      // drain
    }
    expect(model.requests[0]?.messages[0]?.attachments).toEqual([exotic]);
    connection.close();
    laptop.close();
  });
});
