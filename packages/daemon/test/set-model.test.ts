/**
 * `session/models` and `session/set_model` (docs/feat/model-switch.md T3),
 * through a real `Connection`: a switch applies from the next request, is
 * refused while a turn runs (nothing changes), and needs a catalogue and a
 * switch. Fake providers only.
 */
import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import {
  type ChatRequest,
  type ExecutionEnvironment,
  type ModelProvider,
  PermissionBroker,
  type StreamEvent,
} from "@tentacle/core";
import { DomainErrorCode, JsonRpcErrorCode, PROTOCOL_VERSION } from "@tentacle/protocol";
import { ToolRegistry } from "@tentacle/tools";
import { RpcPeer, createChannelPair } from "@tentacle/transport";
import { Connection } from "../src/connection.ts";
import { type ModelSwitch, SessionHost } from "../src/session-host.ts";

const env: ExecutionEnvironment = {
  id: "noop",
  exec: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
  readFile: async () => "",
  writeFile: async () => {},
};

const CATALOGUE = {
  start: { model: "start-id", contextWindow: 1000 },
  entries: [{ name: "haiku", model: "haiku-id", contextWindow: 200 }],
};

/** A host whose agents run on a switchable pair of fake providers. */
function rig(options: { catalogue?: boolean; switchable?: boolean } = {}) {
  const requests: string[] = [];
  let release: () => void = () => {};
  let gate: Promise<void> | undefined;
  const provider = (id: string): ModelProvider => ({
    id,
    async *stream(_request: ChatRequest): AsyncIterable<StreamEvent> {
      requests.push(id);
      await gate;
      yield { type: "text", delta: "ok" };
      yield { type: "done" };
    },
  });
  const start = provider("start");
  const haiku = provider("haiku");
  const switches: ModelSwitch[] = [];
  const host = new SessionHost({
    defaultCwd: "/tmp/set-model",
    ...(options.catalogue === false ? {} : { models: () => CATALOGUE }),
    createAgent: () => {
      let selected: string | null = null;
      const target = () => (selected === null ? start : haiku);
      const modelSwitch: ModelSwitch = {
        current: () => selected,
        select: (name) => {
          if (name !== null && name !== "haiku") {
            throw new Error(`no models entry ${JSON.stringify(name)}`);
          }
          selected = name;
          return name === null
            ? { model: "start-id", contextWindow: 1000 }
            : { model: "haiku-id", contextWindow: 200 };
        },
      };
      switches.push(modelSwitch);
      return {
        agent: new Agent({
          model: {
            get id() {
              return target().id;
            },
            stream: (request) => target().stream(request),
          },
          tools: new ToolRegistry(),
          env,
        }),
        permissions: new PermissionBroker(),
        ...(options.switchable === false ? {} : { modelSwitch }),
      };
    },
  });
  const [d, c] = createChannelPair();
  new Connection(d, host);
  let turnEnds = 0;
  const client = new RpcPeer(c, {
    onNotification: (_method, params) => {
      if ((params as { update?: { type?: string } }).update?.type === "turn_end") {
        turnEnds += 1;
      }
    },
    onRequest: async (method) => {
      throw new Error(`unexpected request ${method}`);
    },
  });
  const until = async (done: () => boolean): Promise<void> => {
    for (let i = 0; i < 500; i++) {
      if (done()) {
        return;
      }
      await new Promise((r) => setTimeout(r, 2));
    }
    throw new Error("timed out");
  };
  return {
    requests,
    switches,
    open: async () => {
      await client.request("initialize", {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: { streaming: true },
      });
      await client.request("session/open", { sessionId: "S", create: true });
    },
    request: (method: string, params: unknown) => client.request(method, params),
    /** A whole turn: sent, then waited to its end. */
    turn: async (turnId: string) => {
      const before = turnEnds;
      await client.request("session/prompt", {
        sessionId: "S",
        turnId,
        content: [{ type: "text", text: "go" }],
      });
      await until(() => turnEnds > before);
    },
    /** Hold the next provider calls until `release()`. */
    hold: () => {
      const held = Promise.withResolvers<void>();
      gate = held.promise;
      release = held.resolve;
    },
    release: () => release(),
    until,
  };
}

const failure = async (request: Promise<unknown>) => {
  try {
    await request;
  } catch (error) {
    return error as { code?: number; message: string };
  }
  throw new Error("expected a refusal");
};

describe("session/set_model", () => {
  test("switches from the next request, and null returns to the start model", async () => {
    const r = rig();
    await r.open();
    await r.turn("t1");
    expect(await r.request("session/set_model", { sessionId: "S", name: "haiku" })).toEqual({
      active: "haiku",
      model: "haiku-id",
      contextWindow: 200,
    });
    await r.turn("t2");
    expect(r.requests).toEqual(["start", "haiku"]);
    expect(await r.request("session/set_model", { sessionId: "S", name: null })).toEqual({
      active: null,
      model: "start-id",
      contextWindow: 1000,
    });
    await r.turn("t3");
    expect(r.requests).toEqual(["start", "haiku", "start"]);
  });

  test("`session/clear` resets in place: the same agent, so the selection stays", async () => {
    const r = rig();
    await r.open();
    await r.request("session/set_model", { sessionId: "S", name: "haiku" });
    await r.request("session/clear", { sessionId: "S" });
    await r.turn("t1");
    expect(r.requests).toEqual(["haiku"]);
  });

  test("is refused while a turn runs, and nothing changes", async () => {
    const r = rig();
    await r.open();
    r.hold();
    await r.request("session/prompt", {
      sessionId: "S",
      turnId: "t1",
      content: [{ type: "text", text: "go" }],
    });
    await r.until(() => r.requests.length === 1);
    const error = await failure(r.request("session/set_model", { sessionId: "S", name: "haiku" }));
    expect(error.code).toBe(DomainErrorCode.TurnInProgress);
    expect(r.switches.map((s) => s.current())).toEqual([null]);
    r.release();
  });

  test("an unknown name is InvalidParams naming the known ones; state unchanged", async () => {
    const r = rig();
    await r.open();
    await r.request("session/set_model", { sessionId: "S", name: "haiku" });
    const error = await failure(r.request("session/set_model", { sessionId: "S", name: "nope" }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(error.message).toContain('"nope"');
    expect(error.message).toContain("haiku");
    expect(r.switches.map((s) => s.current())).toEqual(["haiku"]);
  });

  test("an omitted name is refused, never read as a reset", async () => {
    const r = rig();
    await r.open();
    await r.request("session/set_model", { sessionId: "S", name: "haiku" });
    const error = await failure(r.request("session/set_model", { sessionId: "S" }));
    expect(error.code).toBe(JsonRpcErrorCode.InvalidParams);
    expect(r.switches.map((s) => s.current())).toEqual(["haiku"]);
  });

  for (const [label, options] of [
    ["a session with no switch", { switchable: false }],
    ["a host with no catalogue", { catalogue: false }],
  ] as const) {
    test(`${label} refuses both methods`, async () => {
      const r = rig(options);
      await r.open();
      for (const request of [
        () => r.request("session/set_model", { sessionId: "S", name: "haiku" }),
        () => r.request("session/models", { sessionId: "S" }),
      ]) {
        const error = await failure(request());
        expect(error.code).toBe(JsonRpcErrorCode.InvalidRequest);
        expect(error.message).toContain("model switching is not available");
      }
      expect(r.switches.map((s) => s.current())).toEqual([null]);
    });
  }
});

describe("session/models", () => {
  test("with a session: the catalogue and its selection", async () => {
    const r = rig();
    await r.open();
    expect(await r.request("session/models", { sessionId: "S" })).toEqual({
      ...CATALOGUE,
      active: null,
    });
    await r.request("session/set_model", { sessionId: "S", name: "haiku" });
    expect(await r.request("session/models", { sessionId: "S" })).toEqual({
      ...CATALOGUE,
      active: "haiku",
    });
  });

  test("without a session: the catalogue alone; an unknown session is refused", async () => {
    const r = rig();
    await r.open();
    await r.request("session/set_model", { sessionId: "S", name: "haiku" });
    expect(await r.request("session/models", {})).toEqual({ ...CATALOGUE, active: null });
    const error = await failure(r.request("session/models", { sessionId: "ghost" }));
    expect(error.code).toBe(DomainErrorCode.UnknownSession);
  });
});
