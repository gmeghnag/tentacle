/**
 * One computer's link (docs/feat/mobile-app-shell.md): the SAME `RemoteClient` ↔
 * `Connection` stack every other frontend drives (AGENTS §7 "one session path").
 * No React here and no new transport — only `openComputer`, which dials with the
 * client's own `webSocketChannelFactory` over React Native's WebSocket, exactly
 * as the spike did (eval "First run on a real iPhone: GREEN").
 *
 * The ONE broker (AGENTS §7): a `PermissionBroker` with an explicit `denyAll`
 * requester, never the `allowAll` default. 11a opens no session, so no ask can
 * arrive; the deny requester is belt and braces, and the test pins it.
 */
import {
  type ChannelFactoryDeps,
  RemoteClient,
  type WebSocketCtor,
  webSocketChannelFactory,
} from "@tentacle/client";
import type { LinkStatus } from "@tentacle/client";
import { PermissionBroker, denyAll } from "@tentacle/core";
import type { InitializeResult } from "@tentacle/protocol";
import type { ComputerRecord } from "./computers.ts";
import type { RNWebSocketCtor } from "./rn-websocket.ts";
import { rnWebSocketCtor } from "./rn-websocket.ts";

export interface OpenComputerDeps {
  /** React Native's global `WebSocket` (injected: this module imports no RN). */
  readonly WebSocket: RNWebSocketCtor;
  readonly onError?: (error: Error) => void;
}

export interface ComputerLink {
  readonly client: RemoteClient;
  /** The handshake's answer: the daemon's protocol version and capabilities. */
  readonly init: InitializeResult;
  /** Subscribes to link state; returns the unsubscribe (an effect cleanup). */
  onStatus(listener: (status: LinkStatus) => void): () => void;
  /** Closes the client and every session it holds. The screen's unmount calls this. */
  close(): Promise<void>;
}

interface DiagnosticSocket {
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

/**
 * Logs what RN reports on a failed/closed socket. Data for task 9's 401 split —
 * nothing here classifies by it: iOS reports a bad token and an Origin
 * rejection as the same close 1006 (spike Review finding 3).
 */
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

/**
 * Dial a computer, perform `initialize`, and hand back the client. Rejects when
 * the first dial or the handshake fails — the caller shows the message and
 * offers Retry; a link that drops later is redialled by `channelFactory`.
 */
export async function openComputer(
  record: ComputerRecord,
  deps: OpenComputerDeps,
): Promise<ComputerLink> {
  const log = (line: string) => console.log(`[tentacle] ${line}`);
  const Ctor = withDiagnostics(rnWebSocketCtor(deps.WebSocket), log);
  const factoryDeps: ChannelFactoryDeps = { WebSocket: Ctor };
  const dial = webSocketChannelFactory(
    record.url,
    record.token === undefined ? {} : { token: record.token },
    factoryDeps,
  );
  const channel = await dial();
  const broker = new PermissionBroker(denyAll);
  const client = new RemoteClient(channel, broker, undefined, {
    channelFactory: dial,
    onError: (error) => {
      log(`client error: ${error.message}`);
      deps.onError?.(error);
    },
  });
  try {
    const init = await client.initialize();
    return {
      client,
      init,
      onStatus: (listener) => client.onLinkStatus(listener),
      close: async () => {
        await client.closeSessions();
        client.close();
      },
    };
  } catch (error) {
    // A half-open client would keep re-dialling after the screen is gone.
    await client.closeSessions().catch(() => {});
    client.close();
    throw error;
  }
}
