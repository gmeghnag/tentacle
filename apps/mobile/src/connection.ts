/**
 * One computer's link (docs/feat/mobile-app-shell.md): the SAME `RemoteClient` ↔
 * `Connection` stack every other frontend drives (AGENTS §7 "one session path").
 * No React here and no new transport — only `openComputer`, which dials with the
 * client's own `webSocketChannelFactory` over React Native's WebSocket, exactly
 * as the spike did (eval "First run on a real iPhone: GREEN").
 *
 * The ONE broker (AGENTS §7): a `PermissionBroker` built `holdUntilSet`, with NO
 * requester — the session screen sets the permission sheet's requester on mount
 * and `reset()`s it on unmount (docs/feat/mobile-session-view.md 12a.1). While
 * no requester is set a daemon-side ask WAITS; it is never answered by the phone
 * without a person, and never `allowAll` (11a's `denyAll` answered every ask
 * with a "No" nobody gave — the plan's Repro 2).
 */
import {
  type ChannelFactoryDeps,
  RemoteClient,
  type WebSocketCtor,
  webSocketChannelFactory,
} from "@tentacle/client";
import type { LinkStatus } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import type { InitializeResult } from "@tentacle/protocol";
import type { DuplexChannel } from "@tentacle/transport";
import type { ComputerRecord } from "./computers.ts";
import { createForegroundGate } from "./foreground-gate.ts";
import type { RNWebSocketCtor } from "./rn-websocket.ts";
import { rnWebSocketCtor } from "./rn-websocket.ts";

export interface OpenComputerDeps {
  /** React Native's global `WebSocket` (injected: this module imports no RN). */
  readonly WebSocket: RNWebSocketCtor;
  readonly onError?: (error: Error) => void;
}

export interface ComputerLink {
  readonly client: RemoteClient;
  /**
   * The client's ONE broker: what the permission sheet sets its requester on
   * (`setRequester` on mount, `reset()` on unmount). Exposed, not re-created — a
   * second broker would silently decouple the sheet from the daemon's asks.
   */
  readonly permissions: PermissionBroker;
  /** The handshake's answer: the daemon's protocol version and capabilities. */
  readonly init: InitializeResult;
  /** Subscribes to link state; returns the unsubscribe (an effect cleanup). */
  onStatus(listener: (status: LinkStatus) => void): () => void;
  /** Holds the redial and drops the live socket while the app is in the background (iOS suspends JS). */
  suspend(): void;
  /** The app is active again: let the client redial (its own re-attach does the rest). */
  resume(): void;
  /**
   * Closes the socket and every wait on it — and DETACHES, never ends: no
   * `session/close` is ever sent (decision 4, Hazard 3). The sessions outlive
   * this app.
   */
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
 * The phone's ONE broker (AGENTS §7): `holdUntilSet` and no requester, so a
 * daemon-side ask WAITS until the permission sheet sets one — never `allowAll`,
 * never `denyAll` (11a's deny requester answered every ask with a "No" nobody
 * gave: the plan's Repro 2). Exported because it is the app's single source of
 * truth for this decision, and the link test drives exactly it.
 */
export function createLinkBroker(): PermissionBroker {
  return new PermissionBroker(undefined, { holdUntilSet: true });
}

/**
 * Leave a computer: what the link's `close()` (and the app's unmount) does.
 * `drain()` sends what is still in flight (an answer given a moment ago) and
 * `close()` drops the socket, which the daemon takes as a DETACH — the session
 * keeps running for every device (decision 4). `closeSessions()` here was
 * Hazard 3: as the last attached client, leaving the app ENDED the session.
 * Exported so the exit path has ONE implementation, which the link test drives.
 */
export async function leaveComputer(client: RemoteClient): Promise<void> {
  await client.drain();
  client.close();
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
  // The gate wraps the ONE factory the client dials with: `suspend` closes the
  // live socket and holds the redial, `resume` releases it (12a.4). The client
  // then takes its ordinary drop + redial + re-attach path — no new recovery
  // code (AGENTS §7 "one session path").
  const gate = createForegroundGate(() => dial() as Promise<DuplexChannel>);
  const channel = await gate.dial();
  const broker = createLinkBroker();
  const client = new RemoteClient(channel, broker, undefined, {
    channelFactory: gate.dial,
    onError: (error) => {
      log(`client error: ${error.message}`);
      deps.onError?.(error);
    },
  });
  try {
    const init = await client.initialize();
    return {
      client,
      permissions: broker,
      init,
      onStatus: (listener) => client.onLinkStatus(listener),
      suspend: () => gate.suspend(),
      resume: () => gate.resume(),
      // DETACH, never close (12a.2; see `leaveComputer`).
      close: () => leaveComputer(client),
    };
  } catch (error) {
    // A half-open client would keep re-dialling after the screen is gone.
    await client.drain().catch(() => {});
    client.close();
    throw error;
  }
}
