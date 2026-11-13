/**
 * Image REFS cross the pod tunnel (docs/feat/attachments-core.md, D7, T7) and
 * the laptop's SCOPED byte source rides it (docs/feat/attachments-prompt.md D6, T8).
 *
 * The pod runs the loop; the laptop holds the model. A `ChatMessage` with refs
 * must arrive at the laptop's provider with those refs intact — and, when the
 * laptop itself added the bytes (`attachImage`), with a source that yields
 * exactly those bytes. The laptop may read only ids IT added itself, in this
 * process: never a pod-named id, never a laptop file (AGENTS §7 "a pod is not
 * trusted"). Three RPCs must each hand the provider that source —
 * `model/stream`, `model/streamChunked` and `model/countTokens` — because a
 * laptop that wired two of them would silently turn the third path's images
 * into placeholders.
 *
 * Real `Connection` + `RemoteClient` over a channel pair, as in
 * `model-stream-stop-reason.test.ts`, so this is what the laptop actually sees.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttachmentRef, ChatRequest, ModelProvider, StreamEvent } from "@tentacle/core";
import { PermissionBroker } from "@tentacle/core";
import { Connection, LogSessionStore, ProxyModelProvider, SessionHost } from "@tentacle/daemon";
import { type DuplexChannel, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";
import { ImagesUnavailableError } from "../src/remote-client.ts";

const ref = (over: Partial<AttachmentRef> = {}): AttachmentRef => ({
  id: "a".repeat(64),
  mimeType: "image/png",
  size: 1234,
  name: "cat.png",
  ...over,
});

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text);

/** A ref whose id/size match `text`'s bytes exactly. */
const refFor = (text: string): AttachmentRef => {
  const bytes = bytesOf(text);
  return { id: sha(bytes), mimeType: "image/png", size: bytes.length, name: "shot.png" };
};

/** The laptop's model: records the request it was handed, then finishes. */
class RecordingModel implements ModelProvider {
  readonly id = "recording";
  readonly requests: ChatRequest[] = [];
  async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
    this.requests.push(request);
    yield { type: "text", delta: "ok" };
    yield { type: "done" };
  }
  /** Recorded too: `model/countTokens` must hand over the same source. */
  async countTokens(request: ChatRequest): Promise<number> {
    this.requests.push(request);
    return 1;
  }
}

function connected(model: ModelProvider) {
  const [d, c] = createChannelPair();
  const laptop = new RemoteClient(c, new PermissionBroker(), model);
  return { laptop, podEnd: d };
}

/** A laptop that also serves images itself (the pod's model link). */
function connectedWithImages(model: ModelProvider) {
  const [d, c] = createChannelPair();
  const laptop = new RemoteClient(c, new PermissionBroker(), model, {
    localImages: { vision: true, maxBytes: 4 * 1024 * 1024 },
  });
  return { laptop, podEnd: d };
}

function podHost(): SessionHost {
  return new SessionHost({
    defaultCwd: "/pod/work",
    // The pod declares that it holds no bytes of its own: the laptop is the
    // model link, so the LAPTOP is where an image's bytes live (D2/D6).
    images: { source: "client" },
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

  test("a laptop that added no image: the pod's refs read `null` through the scoped source", async () => {
    const { requests, laptop, connection } = await tunnel(true);
    // The field is never on the wire, so the pod cannot supply a source — and
    // the laptop's own is scoped to what IT added (`attachImage`): empty here,
    // so every pod-named ref is `null` → a visible placeholder, never bytes.
    const source = requests[0]?.attachments;
    if (source === undefined) throw new Error("the laptop attaches its own scoped source");
    expect(await source.read(ref())).toBeNull();
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

/** A pod tunnel whose laptop ALSO holds images (a `--model-proxy` session). */
async function imageTunnel(): Promise<{
  laptop: RemoteClient;
  connection: Connection;
  proxy: ProxyModelProvider;
  model: RecordingModel;
}> {
  const model = new RecordingModel();
  const { laptop, podEnd } = connectedWithImages(model);
  const connection = new Connection(podEnd, podHost());
  const proxy = new ProxyModelProvider(
    (request) => connection.requestModelStream(request),
    (request, handlers) => connection.requestModelStreamChunked(request, handlers),
  );
  await laptop.initialize();
  return { laptop, connection, proxy, model };
}

/** One proxy turn naming `named`, drained; returns what the laptop's model saw. */
async function streamed(
  t: { proxy: ProxyModelProvider; model: RecordingModel },
  named: AttachmentRef,
): Promise<ChatRequest> {
  for await (const _ of t.proxy.stream({
    messages: [{ role: "user", content: "?", attachments: [named] }],
  })) {
    // drain
  }
  const seen = t.model.requests.at(-1);
  if (!seen) throw new Error("the laptop's model was never called");
  return seen;
}

describe("T8 — the laptop's scoped source at every serving cast", () => {
  test("model/streamChunked carries it, yielding exactly the bytes", async () => {
    const t = await imageTunnel();
    const text = "a real png";
    const named = refFor(text);
    await t.laptop.attachImage("S", bytesOf(text), { mimeType: "image/png" });
    const seen = await streamed(t, named);
    expect(seen.attachments).toBe(t.laptop.images);
    expect(await seen.attachments?.read(named)).toEqual(bytesOf(text));
    t.connection.close();
    t.laptop.close();
  });

  test("model/stream (an older pod's batch cut) carries it too", async () => {
    const t = await imageTunnel();
    const text = "batch";
    const named = refFor(text);
    await t.laptop.attachImage("S", bytesOf(text), { mimeType: "image/png" });
    for await (const _ of t.proxy.stream({
      messages: [{ role: "user", content: "?", attachments: [named] }],
    })) {
      // drain
    }
    const seen = t.model.requests.at(-1);
    if (!seen) throw new Error("the laptop's model was never called");
    expect(seen.attachments).toBe(t.laptop.images);
    expect(await seen.attachments?.read(named)).toEqual(bytesOf(text));
    t.connection.close();
    t.laptop.close();
  });

  test("model/countTokens carries it too", async () => {
    const t = await imageTunnel();
    const text = "counted";
    const named = refFor(text);
    await t.laptop.attachImage("S", bytesOf(text), { mimeType: "image/png" });
    await t.connection.requestModelCountTokens({
      messages: [{ role: "user", content: "?", attachments: [named] }],
    });
    const seen = t.model.requests.at(-1);
    if (!seen) throw new Error("the laptop's model was never called");
    expect(seen.attachments).toBe(t.laptop.images);
    expect(await seen.attachments?.read(named)).toEqual(bytesOf(text));
    t.connection.close();
    t.laptop.close();
  });

  test("a ref the laptop never added reads `null` (a hostile pod names anything)", async () => {
    const t = await imageTunnel();
    const stranger: AttachmentRef = {
      id: "f".repeat(64),
      mimeType: "image/png",
      size: 4,
      name: "steal.png",
    };
    const seen = await streamed(t, stranger);
    // The source is there, but it answers nothing for an id it never stored:
    // no laptop file is opened, no bytes leave the laptop.
    expect(seen.attachments).toBe(t.laptop.images);
    expect(await seen.attachments?.read(stranger)).toBeNull();
    t.connection.close();
    t.laptop.close();
  });

  test("a held id named with the WRONG size reads `null` (size is verified)", async () => {
    const t = await imageTunnel();
    const text = "sized";
    const named = refFor(text);
    await t.laptop.attachImage("S", bytesOf(text), { mimeType: "image/png" });
    const seen = await streamed(t, { ...named, size: named.size + 1 });
    expect(await seen.attachments?.read({ ...named, size: named.size + 1 })).toBeNull();
    t.connection.close();
    t.laptop.close();
  });

  test("attachImage sent no attachment/put frame (the bytes stayed here)", async () => {
    const model = new RecordingModel();
    const [daemonCh, clientCh] = createChannelPair();
    const sent: string[] = [];
    // The tap wraps the CLIENT end: it records what the laptop writes, then
    // hands the frame to the peer.
    const tap: DuplexChannel = {
      send: (data: string) => {
        const frame = JSON.parse(data) as { method?: string };
        if (frame.method !== undefined) sent.push(frame.method);
        clientCh.send(data);
      },
      close: () => clientCh.close(),
      setOnMessage: (handler: (d: string) => void) => clientCh.setOnMessage(handler),
      setOnClose: (handler: () => void) => clientCh.setOnClose(handler),
    };
    const connection = new Connection(daemonCh, podHost());
    const laptop = new RemoteClient(tap, new PermissionBroker(), model, {
      localImages: { vision: true, maxBytes: 4 * 1024 * 1024 },
    });
    await laptop.initialize();
    const before = sent.length;
    await laptop.attachImage("S", bytesOf("local only"), { mimeType: "image/png" });
    expect(sent.slice(before)).toEqual([]);
    connection.close();
    laptop.close();
  });

  // Review round 1, finding 1 (HIGH): the pod picks its own `initialize`
  // answer, so `input: "upload"` from a daemon this laptop is the model link
  // for is a CLAIM, not a fact (a replaced binary, or any same-uid process on
  // the resident socket). Believing it puts the screenshot's bytes inside the
  // pod, where any pod process reads them (AGENTS §7; upload Owner Q2).
  test("a pod that claims `upload` to its own model link gets ZERO bytes", async () => {
    const model = new RecordingModel();
    const [daemonCh, clientCh] = createChannelPair();
    const sent: string[] = [];
    const tap: DuplexChannel = {
      send: (data: string) => {
        const frame = JSON.parse(data) as { method?: string };
        if (frame.method !== undefined) sent.push(frame.method);
        clientCh.send(data);
      },
      close: () => clientCh.close(),
      setOnMessage: (handler: (d: string) => void) => clientCh.setOnMessage(handler),
      setOnClose: (handler: () => void) => clientCh.setOnClose(handler),
    };
    // A `store` host advertises exactly `{input:"upload", maxBytes}`.
    const connection = new Connection(
      daemonCh,
      new SessionHost({
        defaultCwd: "/pod/work",
        images: { source: "store", maxBytes: 4 * 1024 * 1024 },
        createAgent: () => {
          throw new Error("not used: no session is opened here");
        },
      }),
    );
    const laptop = new RemoteClient(tap, new PermissionBroker(), model, {
      localImages: { vision: true, maxBytes: 4 * 1024 * 1024 },
    });
    await laptop.initialize();
    const before = sent.length;
    let refused: unknown;
    try {
      await laptop.attachImage("S", bytesOf("a screenshot"), { mimeType: "image/png" });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(ImagesUnavailableError);
    // Not one `attachment/put`, not one chunk of the bytes: the frame log is
    // the proof, and it covers every write this client made.
    expect(sent.slice(before)).toEqual([]);
    expect(laptop.imageInput().kind).toBe("off");
    connection.close();
    laptop.close();
  });
});

describe("T10 (docs/feat/attachments-durable.md D6): a laptop model link that never attached serves from the laptop's disk, in scope only", () => {
  test("two clients on one laptop store: the non-attaching one serves model/stream with the bytes; a foreign id stays null", async () => {
    const dir = await mkdtemp(join(tmpdir(), "laptop-fallback-"));
    try {
      const store = new LogSessionStore(dir);
      // Client A (the TUI that attached) kept its image under its session "S";
      // another laptop session "T" holds a different image.
      const mine = bytesOf("attached by A to S");
      const foreign = bytesOf("attached to T, another session");
      await store.putBlob("S", sha(mine), mine);
      await store.putBlob("T", sha(foreign), foreign);
      const mineRef = { ...refFor("attached by A to S") };
      const foreignRef = { ...refFor("attached to T, another session") };

      // Client B: the pod's model link, never attached anything.
      const model = new RecordingModel();
      const [d, c] = createChannelPair();
      const reads: string[] = [];
      const b = new RemoteClient(c, new PermissionBroker(), model, {
        localImages: { vision: true, maxBytes: 4 * 1024 * 1024 },
        imageFallback: (uid, r) => {
          reads.push(uid);
          return store.readBlob(uid, r.id);
        },
      });
      b.images.allowSession("S");
      const connection = new Connection(d, podHost());
      const proxy = new ProxyModelProvider(
        (request) => connection.requestModelStream(request),
        (request, handlers) => connection.requestModelStreamChunked(request, handlers),
      );
      await b.initialize();
      // The pod names both: the one in scope, and one it injected (e.g. via its
      // own session/log) that the laptop holds only under another session.
      for await (const _ of proxy.stream({
        messages: [
          { role: "user", content: "look", attachments: [mineRef, foreignRef] },
        ],
      })) {
        // drain
      }
      const source = model.requests[0]?.attachments;
      if (source === undefined) throw new Error("the laptop attaches its own scoped source");
      const got = await source.read(mineRef);
      expect(got !== null && Buffer.compare(got, mine) === 0).toBe(true);
      expect(await source.read(foreignRef)).toBeNull();
      expect(reads.every((uid) => uid === "S")).toBe(true);
      // Nothing was ever added to memory: it came from the disk, in scope.
      expect(b.images.count).toBe(0);
      connection.close();
      b.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
