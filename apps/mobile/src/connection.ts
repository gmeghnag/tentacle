/**
 * One computer's link (docs/feat/mobile-app-shell.md 11a; the `/e2e` route is
 * docs/feat/mobile-pairing-screen.md 11b.1, Design 3): the SAME `RemoteClient` ↔
 * `Connection` stack every other frontend drives (AGENTS §7 "one session path").
 *
 * 11b.1's whole connection change: the factory every screen dials is now
 * `secureChannelFactory(dial-to-/e2e, { staticKey: this phone's key for this
 * computer, remoteStatic: the pinned computer key, random: expo-crypto })`. That
 * is a DECORATOR over the same `webSocketChannelFactory` — no token, no proxy,
 * no second session path — and `RemoteClient` takes it as `channelFactory`
 * unchanged, so every redial is a fresh dial and a fresh handshake.
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
import { secureChannelFactory } from "@tentacle/client/secure-channel";
import { PermissionBroker } from "@tentacle/core";
import { type InitializeResult, decodeBase64Url } from "@tentacle/protocol";
import type { DuplexChannel } from "@tentacle/transport";
import type { Random } from "@tentacle/transport/noise";
import { type DialFailure, type DialMemory, firstAnswering } from "./address-dial.ts";
import { type AppLog, type AppLogField, createAppLog, errorShape } from "./app-log.ts";
import type { StoredComputer } from "./computers.ts";
import { createForegroundGate } from "./foreground-gate.ts";
import { sha256Hex } from "./hash.ts";
import { type LinkDiagnoser, createLinkDiagnoser } from "./link-diagnosis.ts";
import type { RNWebSocketCtor } from "./rn-websocket.ts";
import { rnWebSocketCtor } from "./rn-websocket.ts";

/**
 * The client options EVERY link here is built with, apart from the channel.
 *
 * `sha256Bytes` is the load-bearing one (docs/feat/mobile-compose.md 13c, the
 * plan's Repro 2): `RemoteClient` defaults it to Bun's `CryptoHasher`, which is
 * `undefined` under Hermes, and then `attachImage` throws "needs a binary
 * sha-256 hasher" before a single frame. Exported so the wiring is testable and
 * so a second construction site cannot quietly forget it (AGENTS §7: one
 * session path, one set of options).
 */
export const APP_CLIENT_OPTIONS = { sha256Bytes: sha256Hex } as const;

export interface OpenComputerDeps {
  /** React Native's global `WebSocket` (injected: this module imports no RN). */
  readonly WebSocket: RNWebSocketCtor;
  /** Randomness for the Noise handshake (`expo-crypto` on the phone: Hermes has no WebCrypto). */
  readonly random: Random;
  /**
   * The diagnosis to feed, when the caller keeps ONE per computer: a dial that
   * fails THREE times across mounts (a computer reset, F-L3) can only be called
   * `maybe-reset` by a diagnoser that outlives a single attempt. Omitted = a
   * fresh one for this link.
   */
  readonly diagnosis?: LinkDiagnoser;
  readonly onError?: (error: Error) => void;
  /**
   * Where the socket diagnostics go (docs/feat/mobile-lock.md D7). Omitted = a
   * module-private ring, so a link built without one still has a log and no call
   * site has to check. The sink redacts (it is the only place a URL or a
   * daemon's `reason` text reaches a file a person may share).
   */
  readonly log?: AppLog;
}

/** A record this phone cannot dial: the stored key is not a 32-byte X25519 key. */
export class ComputerRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ComputerRecordError";
  }
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
  /**
   * Why the computer is not answering (`revoked` / `maybe-reset` /
   * `unreachable`), fed by the dial wrapper's error OBJECTS — never by the
   * link's `stopped.reason` text (see `link-diagnosis.ts`).
   */
  readonly diagnosis: LinkDiagnoser;
  /** Which address the link is dialling (the one that last answered). */
  readonly address: () => string;
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
 * Logs what RN reports on a failed/closed socket. On `/e2e` the handshake now
 * carries the verdict (a Noise `denied` is authenticated), so this stays what it
 * was: data for a bug report, never a classification.
 *
 * `url` itself is NEVER logged (P3: the query carries the token on iOS); only the
 * host it was dialling, which is what Owner Q8 allows. The `error` and `close`
 * payloads are daemon/toolchain text (P4) and reach NO field at all: `redact()`
 * cannot tell prose from prose, so a path, a title or a prompt fragment in one of
 * them would survive into a shared export (F16; review round 1, finding 2). What
 * is logged is machine-readable only — the close CODE, and the error's CLASS
 * (`errorShape`), never its message.
 *
 * Exported for its own test, which drives a socket that really does hand it
 * canary text: the app has ONE such wrapper and it must stay text-free.
 */
export function withDiagnostics(Ctor: WebSocketCtor, log: AppLog): WebSocketCtor {
  return class {
    constructor(url: string, init?: unknown) {
      const ws = new Ctor(url, init) as DiagnosticSocket;
      let host = "";
      try {
        host = new URL(url).host;
      } catch {
        host = ""; // an unparseable URL is not echoed at all
      }
      log.log("info", "dial", host === "" ? {} : { host });
      ws.addEventListener("error", (event) => {
        // The CLASS only. A socket error's `message` is toolchain text about a URL
        // (`WebSocket connection to 'wss://…?token=…' failed`), so it would carry
        // both a path and the query — `errorShape` keeps the identifier, not it.
        log.log("error", "ws-error", { ...errorShape((event as { error?: unknown }).error) });
      });
      ws.addEventListener("close", (event) => {
        const { code } = event as { code?: unknown };
        // No `reason`: a close reason is the peer's prose (P4), and it is exactly
        // where a title or a prompt fragment would arrive from a daemon.
        log.log("warn", "ws-close", typeof code === "number" ? { code } : {});
      });
      // biome-ignore lint/correctness/noConstructorReturn: an adapter returns the socket itself
      return ws as object;
    }
  } as unknown as WebSocketCtor;
}

/**
 * A client error, as the log may carry it (F16): the CLASS and the numeric code,
 * nothing else. `RemoteClient.onError` carries endpoint bodies, malformed frames
 * and an unknown mandatory update's daemon-supplied `type`, so its `message` is
 * daemon text and never reaches the ring (review round 1, finding 2). Exported
 * for its own test: this is the mapping `onError` logs, and it must stay text-free.
 */
export function clientErrorFields(error: Error): Record<string, AppLogField> {
  return { ...errorShape(error) };
}

/**
 * The ring a link uses when its caller injects no sink. A link is a self-contained
 * thing in the tests, and a `log` parameter that every test had to build would
 * hide the fact that the app always passes ONE shared sink (`app-log.ts`).
 */
function fallbackLog(): AppLog {
  return createAppLog({ now: Date.now, capacity: 500 });
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

/** The stored key, decoded — or a record error naming what is wrong (never a silent empty key). */
function pinnedKey(computer: StoredComputer): Uint8Array {
  const key = decodeBase64Url(computer.computerKey);
  if (key === undefined || key.length !== 32) {
    throw new ComputerRecordError(`'${computer.name}' has an unreadable pinned key — pair again`);
  }
  return key;
}

/**
 * Dial a computer over `/e2e`, perform `initialize`, and hand back the client.
 *
 * Every dial goes through `firstAnswering` (address order, remembered good one,
 * an authenticated `unauthorized` stops the loop) and then the Noise initiator
 * pinned to the stored computer key — so a link is only ever built on an
 * AUTHENTICATED channel to THIS computer. Rejects when no address answers or the
 * handshake fails; the caller shows the message and offers Retry, and a link
 * that drops later is redialled by `channelFactory`.
 */
export async function openComputer(
  computer: StoredComputer,
  deps: OpenComputerDeps,
): Promise<ComputerLink> {
  const log = deps.log ?? fallbackLog();
  const deviceKey = decodeBase64Url(computer.deviceKey);
  if (deviceKey === undefined || deviceKey.length !== 32) {
    throw new ComputerRecordError(`'${computer.name}' has an unreadable device key — pair again`);
  }
  const remoteStatic = pinnedKey(computer);
  if (computer.addresses.length === 0) {
    throw new ComputerRecordError(`'${computer.name}' has no address — pair again`);
  }
  const Ctor = withDiagnostics(rnWebSocketCtor(deps.WebSocket), log);
  const factoryDeps: ChannelFactoryDeps = { WebSocket: Ctor };
  const memory: DialMemory = { lastGood: undefined };
  const diagnosis = deps.diagnosis ?? createLinkDiagnoser();
  let current = computer.addresses[0] ?? "";

  /**
   * One address, in the two steps R6's race needs: OPEN the raw socket (that,
   * and only that, decides the race), then the Noise handshake on the winner.
   * The diagnosis is fed per STEP, and only for steps the RACE still owned: an
   * abandoned loser records nothing (`abandon` is silent), and a loser whose OPEN
   * fails after the race was decided records nothing either — `firstAnswering`
   * drops it (`steps.failed`, review round 1 finding 2). Otherwise a LAN connect
   * error arriving behind an authenticated `denied` would overwrite `revoked`
   * with `unreachable`, and the row would lose its Remove action.
   */
  const steps = {
    open: async (address: string): Promise<DuplexChannel> => {
      current = address;
      // No `observe` here: whether this failure may be reported at all is the
      // race's call (`failed` below), because only the race knows if it had
      // already been decided when the rejection arrived.
      return await webSocketChannelFactory(address, {}, factoryDeps)();
    },
    /**
     * An `open` that failed while its race was still undecided: a path that is
     * down, which says nothing about identity.
     */
    failed: (failure: DialFailure): void => {
      diagnosis.observe({ opened: false, error: failure.error });
    },
    /**
     * A loser of the race, closed BEFORE any handshake: the relay's stream closes
     * pre-handshake (its limiter slot and per-ip stream go back with it), and no
     * daemon-side state is created — the reason the race is decided at open.
     */
    abandon: (channel: DuplexChannel): void => {
      channel.close();
    },
    confirm: async (channel: DuplexChannel): Promise<DuplexChannel> => {
      try {
        // `secureChannelFactory` maps a failed handshake itself (`denied` →
        // `unauthorized`, the authenticated verdict the diagnosis reads).
        return await secureChannelFactory(async () => channel, {
          staticKey: deviceKey,
          remoteStatic,
          random: deps.random,
        })();
      } catch (error) {
        diagnosis.observe({ opened: true, error });
        throw error;
      }
    },
  };

  /**
   * The factory the client redials with: the staggered race over the address list
   * (R6), starting at the remembered good one.
   */
  const dial = async (): Promise<DuplexChannel> => {
    const channel = await firstAnswering(computer.addresses, steps, memory);
    diagnosis.ok();
    return channel;
  };

  // The gate wraps the ONE factory the client dials with: `suspend` closes the
  // live socket and holds the redial, `resume` releases it (12a.4). The client
  // then takes its ordinary drop + redial + re-attach path — no new recovery
  // code (AGENTS §7 "one session path").
  const gate = createForegroundGate(() => dial());
  const channel = await gate.dial();
  const broker = createLinkBroker();
  const client = new RemoteClient(channel, broker, undefined, {
    ...APP_CLIENT_OPTIONS,
    channelFactory: gate.dial,
    onError: (error) => {
      // P4/F16: a client error message is daemon text (an endpoint body, a frame,
      // a pod's own model name) — the CLASS and the code go in, the text does not.
      log.log("error", "client-error", clientErrorFields(error));
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
      diagnosis,
      address: () => current,
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
