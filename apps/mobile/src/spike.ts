/**
 * The spike's one flow (docs/feat/mobile-spike.md): dial `serve` over the
 * client's own `webSocketChannelFactory` with RN's WebSocket, open a session,
 * send one prompt and stream the reply. Same `RemoteClient` ↔ `Connection`
 * stack as `tentacle connect` (cli/src/connect.ts); no React, the deps are
 * injected.
 */
import { RemoteClient, type WebSocketCtor, webSocketChannelFactory } from "@tentacle/client";
import { PermissionBroker, type PermissionRequester } from "@tentacle/core";
import { PROTOCOL_VERSION } from "@tentacle/protocol";
import { type RNWebSocketCtor, rnWebSocketCtor } from "./rn-websocket.ts";

export interface SpikeDeps {
  readonly url: string;
  readonly token?: string;
  readonly prompt: string;
  readonly WebSocket: RNWebSocketCtor;
  readonly log: (line: string) => void;
  readonly onText: (delta: string) => void;
}

interface DiagnosticSocket {
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

/** Logs what RN reports on a failed/closed socket (data for task 11's close-code work). */
function withDiagnostics(Ctor: WebSocketCtor, log: (line: string) => void): WebSocketCtor {
  return class {
    constructor(url: string, init?: unknown) {
      const ws = new Ctor(url, init) as DiagnosticSocket;
      ws.addEventListener("error", (event) => {
        const message = (event as { message?: unknown }).message;
        log(`ws error event: message=${JSON.stringify(message)}`);
      });
      ws.addEventListener("close", (event) => {
        const { code, reason } = event as { code?: unknown; reason?: unknown };
        log(`ws close event: code=${String(code)} reason=${JSON.stringify(reason)}`);
      });
      // biome-ignore lint/correctness/noConstructorReturn: an adapter returns the socket itself
      return ws as object;
    }
  } as unknown as WebSocketCtor;
}

/** Q-c: what the JS runtime actually is, logged before anything else. */
function runtimeFacts(log: (line: string) => void): void {
  const g = globalThis as { HermesInternal?: unknown; RN$Bridgeless?: unknown };
  log(`runtime: typeof HermesInternal=${typeof g.HermesInternal}`);
  log(`runtime: RN$Bridgeless=${String(g.RN$Bridgeless)}`);
  const uuid = crypto.randomUUID();
  const shape = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(uuid);
  log(`runtime: crypto.randomUUID()=${uuid} v4-shape=${shape}`);
  const u = new URL("ws://127.0.0.1:1/");
  u.searchParams.set("token", "a b");
  log(`runtime: URL.searchParams round-trip=${u.toString()}`);
}

const spikeDeny =
  (log: (line: string) => void): PermissionRequester =>
  async (req) => {
    log(`permission request DENIED by the spike: ${JSON.stringify(req)}`);
    return { allowed: false };
  };

export async function runSpike(deps: SpikeDeps): Promise<void> {
  const { log } = deps;
  runtimeFacts(log);
  const Ctor = withDiagnostics(rnWebSocketCtor(deps.WebSocket), log);
  const dial = webSocketChannelFactory(deps.url, deps.token ? { token: deps.token } : {}, {
    WebSocket: Ctor,
  });
  log(`dialing ${deps.url} (client protocol v${PROTOCOL_VERSION})`);
  const channel = await dial();
  log("socket open");
  // The ONE broker (AGENTS §7): an explicit deny requester, never the allowAll default.
  const broker = new PermissionBroker(spikeDeny(log));
  const client = new RemoteClient(channel, broker, undefined, {
    channelFactory: dial,
    onError: (error) => log(`client error: ${error.message}`),
  });
  const offStatus = client.onLinkStatus((status) => log(`link: ${JSON.stringify(status)}`));
  try {
    const init = await client.initialize();
    log(
      `initialized: daemon protocol v${init.protocolVersion}, capabilities=${JSON.stringify(init.agentCapabilities)}`,
    );
    const session = client.newSession(undefined, crypto.randomUUID());
    log(`prompt: ${JSON.stringify(deps.prompt)}`);
    for await (const event of session.send(deps.prompt)) {
      if (event.type === "text") {
        log(`text delta @${Date.now()}: ${JSON.stringify(event.delta)}`);
        deps.onText(event.delta);
      } else {
        log(`event: ${event.type}`);
      }
    }
    log("turn done");
  } finally {
    offStatus();
    await client.closeSessions();
    client.close();
    log("closed");
  }
}
