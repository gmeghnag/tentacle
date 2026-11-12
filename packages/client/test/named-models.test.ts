/**
 * The laptop's gate on named model calls (docs/feat/models-map-pod.md). The pod
 * here is HOSTILE: raw JSON-RPC frames straight on the channel, because an
 * `RpcPeer` validates what it sends and could not send a malformed one.
 */
import { describe, expect, test } from "bun:test";
import {
  type ChatRequest,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { JsonRpcErrorCode, Method } from "@tentacle/protocol";
import { createChannelPair } from "@tentacle/transport";
import { type NamedModels, RemoteClient } from "../src/remote-client.ts";

const REQUEST = { messages: [{ role: "user", content: "hi" }] };
const STREAMS = [Method.ModelStream, Method.ModelStreamChunked];
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 2));

interface Frame {
  readonly id?: number;
  readonly result?: unknown;
  readonly error?: { readonly code: number; readonly message: string };
}

function spyModel(id: string) {
  const seen: ChatRequest[] = [];
  const model: ModelProvider = {
    id,
    async *stream(request: ChatRequest): AsyncIterable<StreamEvent> {
      seen.push(request);
      yield { type: "text", delta: `from ${id}` };
      yield { type: "done" };
    },
  };
  return { model, seen };
}

/** A model whose every call holds until `open()`. */
function gatedModel(id: string) {
  let started = 0;
  const gates: (() => void)[] = [];
  const model: ModelProvider = {
    id,
    async *stream(): AsyncIterable<StreamEvent> {
      started += 1;
      await new Promise<void>((resolve) => gates.push(resolve));
      yield { type: "done" };
    },
  };
  return {
    model,
    started: () => started,
    open: () => {
      for (const gate of gates.splice(0)) gate();
    },
  };
}

function namedModels(
  map: Record<string, ModelProvider | "unavailable">,
): NamedModels & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    resolve(name) {
      asked.push(name);
      return Object.hasOwn(map, name) ? map[name] : undefined;
    },
  };
}

function hostilePod(
  main: ModelProvider,
  options: ConstructorParameters<typeof RemoteClient>[3] = {},
) {
  const [podCh, clientCh] = createChannelPair();
  const errors: string[] = [];
  const client = new RemoteClient(clientCh, new PermissionBroker(), main, {
    onError: (e) => errors.push(e.message),
    ...options,
  });
  const pending = new Map<number, (frame: Frame) => void>();
  podCh.setOnMessage((data) => {
    const frame = JSON.parse(data) as Frame;
    if (frame.id !== undefined) {
      pending.get(frame.id)?.(frame);
      pending.delete(frame.id);
    }
  });
  let next = 1;
  const call = (method: string, params: unknown): Promise<Frame> =>
    new Promise((resolve) => {
      const id = next++;
      pending.set(id, resolve);
      podCh.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    });
  return { call, errors, client, podCh };
}

describe("a named call", () => {
  for (const method of STREAMS) {
    test(`${method}: a published name runs ITS provider; no name runs main`, async () => {
      const main = spyModel("main");
      const fast = spyModel("fast");
      const pod = hostilePod(main.model, { namedModels: namedModels({ fast: fast.model }) });
      expect((await pod.call(method, { request: REQUEST, model: "fast" })).error).toBeUndefined();
      expect([fast.seen.length, main.seen.length]).toEqual([1, 0]);
      expect((await pod.call(method, { request: REQUEST })).error).toBeUndefined();
      expect([fast.seen.length, main.seen.length]).toEqual([1, 1]);
      pod.client.close();
    });
  }
});

describe("a HOSTILE pod", () => {
  for (const method of STREAMS) {
    test(`${method}: an unpublished name is refused, and nothing runs`, async () => {
      const main = spyModel("main");
      const fast = spyModel("fast");
      const pod = hostilePod(main.model, { namedModels: namedModels({ fast: fast.model }) });
      const { error } = await pod.call(method, { request: REQUEST, model: "claude" });
      expect(error?.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(error?.message).toBe('model "claude" is not published by this laptop');
      expect([fast.seen.length, main.seen.length]).toEqual([0, 0]);
      pod.client.close();
    });

    test(`${method}: the main model cannot be named: "main", its id, or a prototype name`, async () => {
      const main = spyModel("main");
      const fast = spyModel("fast");
      const pod = hostilePod(main.model, { namedModels: namedModels({ fast: fast.model }) });
      for (const model of ["main", "default", "MAIN", "qwen3-27b", "__proto__", "constructor"]) {
        const { error } = await pod.call(method, { request: REQUEST, model });
        expect({ model, code: error?.code }).toEqual({
          model,
          code: JsonRpcErrorCode.InvalidRequest,
        });
      }
      expect([fast.seen.length, main.seen.length]).toEqual([0, 0]);
      pod.client.close();
    });

    test(`${method}: what is not a name never reaches the allowlist`, async () => {
      const main = spyModel("main");
      const named = namedModels({});
      const pod = hostilePod(main.model, { namedModels: named });
      for (const model of ["http://evil/v1", "sk-a.b", "a/b", "", "x".repeat(65), 7, null, {}]) {
        const { error } = await pod.call(method, { request: REQUEST, model });
        expect({ model, code: error?.code }).toEqual({
          model,
          code: JsonRpcErrorCode.InvalidParams,
        });
      }
      expect(named.asked).toEqual([]);
      expect(main.seen).toEqual([]);
      pod.client.close();
    });

    test(`${method}: an endpoint or a key in the frame is dropped; the entry's provider serves`, async () => {
      const main = spyModel("main");
      const fast = spyModel("fast");
      const pod = hostilePod(main.model, { namedModels: namedModels({ fast: fast.model }) });
      await pod.call(method, {
        request: { ...REQUEST, baseURL: "http://evil/v1", apiKey: "stolen", model: "gpt" },
        model: "fast",
        baseURL: "http://evil/v1",
        apiKey: "stolen",
        provider: "anthropic",
      });
      // `attachments` is the LAPTOP's own scoped source
      // (docs/feat/attachments-prompt.md D6), added after the pod's fields are
      // stripped: the pod still cannot supply one, and nothing else rides over.
      const keys = Object.keys(fast.seen[0] ?? {}).filter(
        (k) => k !== "signal" && k !== "attachments",
      );
      expect(keys).toEqual(["messages"]);
      expect((fast.seen[0] as { attachments?: unknown }).attachments).toBeDefined();
      pod.client.close();
    });

    test(`${method}: a name on a title call is refused: titles are the laptop's choice`, async () => {
      const main = spyModel("main");
      const fast = spyModel("fast");
      const title = spyModel("title");
      const pod = hostilePod(main.model, {
        namedModels: namedModels({ fast: fast.model }),
        titleModelProvider: title.model,
      });
      const { error } = await pod.call(method, {
        request: REQUEST,
        purpose: "title",
        model: "fast",
      });
      expect(error?.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(error?.message).toBe("a title call names no model");
      expect([fast.seen.length, title.seen.length, main.seen.length]).toEqual([0, 0, 0]);
      expect(
        (await pod.call(method, { request: REQUEST, purpose: "title" })).error,
      ).toBeUndefined();
      expect(title.seen.length).toBe(1);
      pod.client.close();
    });

    test(`${method}: "unavailable" is refused without a call: never an unauthenticated request`, async () => {
      const main = spyModel("main");
      const pod = hostilePod(main.model, { namedModels: namedModels({ claude: "unavailable" }) });
      const { error } = await pod.call(method, { request: REQUEST, model: "claude" });
      expect(error?.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(error?.message).toBe(
        'model "claude" is unavailable on this laptop: its key command did not succeed here',
      );
      expect(main.seen).toEqual([]);
      pod.client.close();
    });

    test(`${method}: with no named models every name is refused`, async () => {
      const main = spyModel("main");
      const pod = hostilePod(main.model);
      const { error } = await pod.call(method, { request: REQUEST, model: "fast" });
      expect(error?.code).toBe(JsonRpcErrorCode.InvalidRequest);
      expect(main.seen).toEqual([]);
      pod.client.close();
    });

    test(`${method}: a named call has the main model's exposure: the request as sent (owner Q1 c)`, async () => {
      const main = spyModel("main");
      const fast = spyModel("fast");
      const pod = hostilePod(main.model, { namedModels: namedModels({ fast: fast.model }) });
      const request = { ...REQUEST, maxTokens: 4096 };
      await pod.call(method, { request, model: "fast" });
      await pod.call(method, { request });
      expect(fast.seen[0]?.maxTokens).toBe(4096);
      expect(main.seen[0]?.maxTokens).toBe(4096);
      pod.client.close();
    });

    test(`${method}: a provider error on a named call reaches the pod opaque`, async () => {
      const main = spyModel("main");
      const leaky: ModelProvider = {
        id: "leaky",
        // biome-ignore lint/correctness/useYield: it fails before its first event
        async *stream(): AsyncIterable<StreamEvent> {
          throw new Error("401 from https://only-laptop.example/v1 with key sk-s3cret-entry");
        },
      };
      const pod = hostilePod(main.model, { namedModels: namedModels({ leaky }) });
      const { error } = await pod.call(method, { request: REQUEST, model: "leaky" });
      expect(error).toBeDefined();
      expect(JSON.stringify(error)).not.toContain("only-laptop.example");
      expect(JSON.stringify(error)).not.toContain("s3cret");
      pod.client.close();
    });
  }

  test("a refused name is logged on the laptop once, and the log is bounded", async () => {
    const main = spyModel("main");
    const pod = hostilePod(main.model, { namedModels: namedModels({}) });
    await pod.call(Method.ModelStream, { request: REQUEST, model: "evil" });
    await pod.call(Method.ModelStream, { request: REQUEST, model: "evil" });
    const named = pod.errors.filter((line) => line.includes("evil"));
    expect(named).toEqual([
      'refused a model call from the pod: model "evil" is not published by this laptop',
    ]);
    for (let i = 0; i < 40; i++) {
      await pod.call(Method.ModelStream, { request: REQUEST, model: `name${i}` });
    }
    expect(pod.errors.filter((line) => line.includes("refused")).length).toBe(16);
    pod.client.close();
  });

  test("a FLOOD of unpublished names, all at once: every one refused, no provider reached", async () => {
    const main = spyModel("main");
    const fast = spyModel("fast");
    const pod = hostilePod(main.model, { namedModels: namedModels({ fast: fast.model }) });
    const frames = await Promise.all(
      Array.from({ length: 200 }, (_, i) =>
        pod.call(i % 2 === 0 ? Method.ModelStream : Method.ModelStreamChunked, {
          request: REQUEST,
          model: `evil${i % 50}`,
        }),
      ),
    );
    expect(frames.every((f) => f.error?.code === JsonRpcErrorCode.InvalidRequest)).toBe(true);
    expect([fast.seen.length, main.seen.length]).toEqual([0, 0]);
    expect(pod.errors.length).toBeLessThanOrEqual(16);
    pod.client.close();
  });

  test("published calls are not limited on the laptop (owner Q1 c), and never delay main", async () => {
    const main = spyModel("main");
    const paid = gatedModel("paid");
    const pod = hostilePod(main.model, { namedModels: namedModels({ paid: paid.model }) });
    const held = Array.from({ length: 40 }, () =>
      pod.call(Method.ModelStream, { request: REQUEST, model: "paid" }),
    );
    await tick();
    expect(paid.started()).toBe(40);
    expect((await pod.call(Method.ModelStream, { request: REQUEST })).error).toBeUndefined();
    expect(main.seen.length).toBe(1);
    paid.open();
    expect((await Promise.all(held)).every((f) => f.error === undefined)).toBe(true);
    pod.client.close();
  });
});
