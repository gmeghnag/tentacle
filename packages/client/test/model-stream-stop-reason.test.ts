/**
 * The stop reason crosses the pod tunnel intact
 * (docs/fix/truncated-reply-silent.md Review HIGH-1).
 *
 * Two hops, both through a STRIP schema: the laptop's `RemoteClient` answers
 * `model/stream` / `model/streamChunked` with `StreamEvent`s the pod parses as
 * `WireStreamEvent`, and the pod's agent decides from that value alone. A field
 * the wire schema does not name disappears there, and a cut reply is then
 * accepted as complete — for `run`/`attach` only, which never ran locally.
 *
 * These drive REAL `Connection` + `RemoteClient` objects over a channel pair, so
 * the assertions are on what the pod actually receives, not on a fake schema.
 */
import { describe, expect, test } from "bun:test";
import { type ChatRequest, type ModelProvider, PermissionBroker } from "@tentacle/core";
import type { StreamEvent } from "@tentacle/core";
import { Connection, ProxyModelProvider, SessionHost } from "@tentacle/daemon";
import { createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

const REQ: ChatRequest = { messages: [{ role: "user", content: "x" }] };

/** The laptop's model: one scripted round, cut at the output limit. */
class CutModel implements ModelProvider {
  readonly id = "cut";
  constructor(private readonly events: readonly StreamEvent[]) {}
  async *stream(): AsyncIterable<StreamEvent> {
    for (const event of this.events) {
      yield event;
    }
  }
}

/** A laptop client plus the daemon end of its channel, over one pair. */
function connected(model: ModelProvider): {
  laptop: RemoteClient;
  podEnd: ConstructorParameters<typeof Connection>[0];
} {
  const [d, c] = createChannelPair();
  const laptop = new RemoteClient(c, new PermissionBroker(), model);
  return { laptop, podEnd: d };
}

async function drained(proxy: ProxyModelProvider): Promise<StreamEvent[]> {
  const seen: StreamEvent[] = [];
  for await (const event of proxy.stream(REQ)) {
    seen.push(event);
  }
  return seen;
}

describe("a cut reply over the pod tunnel", () => {
  test("the chunked cut: `done{stopReason: length}` arrives intact", async () => {
    const { laptop, podEnd } = connected(
      new CutModel([
        { type: "text", delta: "la vera" },
        { type: "done", stopReason: "length" },
      ]),
    );
    const connection = new Connection(podEnd, podHost());
    const proxy = new ProxyModelProvider(
      (request) => connection.requestModelStream(request),
      (request, handlers) => connection.requestModelStreamChunked(request, handlers),
    );
    await laptop.initialize();
    const seen = await drained(proxy);
    expect(seen).toEqual([
      { type: "text", delta: "la vera" },
      { type: "done", stopReason: "length" },
    ]);
    connection.close();
    laptop.close();
  });

  test("the batch cut (an older laptop shape): the same fact survives", async () => {
    const { laptop, podEnd } = connected(
      new CutModel([
        { type: "text", delta: "cut" },
        { type: "done", stopReason: "length" },
      ]),
    );
    const connection = new Connection(podEnd, podHost());
    // Batch only: no chunked sender, so the proxy takes `model/stream`.
    const proxy = new ProxyModelProvider((request) => connection.requestModelStream(request));
    await laptop.initialize();
    const seen = await drained(proxy);
    expect(seen.at(-1)).toEqual({ type: "done", stopReason: "length" });
    connection.close();
    laptop.close();
  });

  test("no stop reason on the laptop's `done` stays absent — never invented", async () => {
    // A provider that does not say (an old shim): the pod sees `undefined` and
    // the loop behaves as before. The field is optional, so nothing fails.
    const { laptop, podEnd } = connected(new CutModel([{ type: "done" }]));
    const connection = new Connection(podEnd, podHost());
    const proxy = new ProxyModelProvider(
      (request) => connection.requestModelStream(request),
      (request, handlers) => connection.requestModelStreamChunked(request, handlers),
    );
    await laptop.initialize();
    const seen = await drained(proxy);
    expect(seen).toEqual([{ type: "done" }]);
    connection.close();
    laptop.close();
  });
});

/** A host that serves no session: these tests only exercise the tunnel. */
function podHost(): SessionHost {
  return new SessionHost({
    defaultCwd: "/pod/work",
    createAgent: () => {
      throw new Error("not used: these tests drain the proxy directly");
    },
  });
}
