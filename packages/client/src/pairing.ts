/**
 * `pairDevice` — the app's side of pairing (docs/feat/device-pairing.md 9c,
 * Design "Client helper").
 *
 * ONE dial per address in payload order, the Noise initiator over it, a peer,
 * `initialize`, `device/pair`, close. That is a one-shot RPC, NOT a session: it
 * never touches `RemoteClient`, so no second session path exists (§7). The
 * app's pairing screen (task 11b) calls it and, when it succeeds, re-dials the
 * SAME address as a device — a connection's privilege is fixed at its
 * handshake, so a pairing connection is never upgraded in place.
 *
 * The compare code (SAS) is reported through `onCompare` BEFORE the code is
 * sent: that is the whole point of it. The human reads it on the computer's
 * terminal and on the phone, and answers the computer's `[y/N]`. Sending first
 * would not leak the code (the channel is already encrypted) but it would let
 * the daemon's claim happen before the human could look; `onCompare` firing
 * first is what the plan pins with a test, and what the mockup's two screens
 * assume.
 *
 * Crypto comes from `@tentacle/transport/noise` only (the SAS and the
 * handshake); this module is reached through the `@tentacle/client/pairing`
 * subpath, like `secure-channel`, so an existing importer loads none of it.
 */
import {
  type DevicePairParams,
  type DevicePairResult,
  DomainErrorCode,
  Method,
  PROTOCOL_VERSION,
  type PairingPayload,
  type PairingRefusedReason,
} from "@tentacle/protocol";
import { type DuplexChannel, RpcError, RpcPeer } from "@tentacle/transport";
import { type Random, pairingSas, publicKeyOf } from "@tentacle/transport/noise";
import { ChannelError } from "./link-machine.ts";
import { channelErrorFromNoise, secureChannelFactory } from "./secure-channel.ts";
/** A `device/pair` refusal, with the reason the daemon gave (never text-matched). */
export class PairingRefused extends Error {
  /** The daemon's reason, or `unknown` for one this build does not know. */
  readonly reason: PairingRefusedReason | "unknown";
  constructor(reason: PairingRefusedReason | "unknown", message: string) {
    super(message);
    this.name = "PairingRefused";
    this.reason = reason;
  }
}

/** What pairing produced: the device id, and which computer accepted it. */
export type PairDeviceResult = DevicePairResult;

export interface PairDeviceOptions {
  /** The scanned/pasted payload (`parsePairingPayload`'s output). */
  readonly payload: PairingPayload;
  /**
   * This device's own static private key — generated once and kept in the
   * Keychain (this-device-only), NOT by this function: the app owns its key.
   */
  readonly deviceKey: Uint8Array;
  /** The name the human is asked to confirm on the computer. */
  readonly name: string;
  /**
   * Opens a raw channel to one address. The app passes its own WebSocket dial
   * (`rn-websocket`); nothing here assumes Bun's.
   */
  readonly dial: (address: string) => () => Promise<DuplexChannel>;
  /**
   * Randomness for the Noise handshake. REQUIRED, like every other
   * `InitiatorOptions`: the transport has no silent fallback, and the app
   * supplies its own (`expo-crypto` — Hermes has no WebCrypto).
   */
  readonly random: Random;
  /**
   * The compare code, called with the SAS and the daemon's protocol version
   * once the channel is confirmed and BEFORE `device/pair` is sent. Awaited, so
   * a UI can show it (and the human can compare) first.
   */
  readonly onCompare?: (
    sas: string,
    info: { readonly protocolVersion: number },
  ) => void | Promise<void>;
  /**
   * Per-request timeout for `initialize` (default 30 s).
   *
   * It does NOT cover `device/pair`: that request waits on a HUMAN pressing
   * `[y/N]` on the computer, and the pairing window lasts `PAIRING_TTL_MS`
   * (5 min), so a 30 s deadline would fail a phone whose user simply took a
   * minute — and the phone would hang up while the claim, and the terminal's
   * prompt, still stood: a `y` then registers a device that reported failure
   * (F3 against the human's intent). The daemon's own expiry answers `timeout`
   * (and its `declined` answers a refusal), which is the ONE deadline the
   * exchange is designed around; a socket that dies is still caught, because
   * `RpcPeer` rejects every pending request when the channel closes.
   */
  readonly requestTimeoutMs?: number;
}

/** Every `PairingRefused` reason, for the app's copy (a switch that must stay exhaustive). */
export const PAIRING_REFUSED_MESSAGES: Record<PairingRefusedReason | "unknown", string> = {
  invalid_code: "the pairing code is wrong or expired — ask the computer for a new QR",
  used: "another device already used this code — ask the computer for a new QR",
  declined: "the pairing was declined on the computer",
  timeout: "the computer did not answer in time — try again",
  too_many_attempts: "too many wrong codes — try again with a new QR",
  already_paired: "this device is already paired",
  unknown: "the computer refused the pairing",
};

/** Map a `device/pair` failure to `PairingRefused` (an unknown reason stays generic). */
export function pairingRefusedFrom(error: unknown): PairingRefused | undefined {
  if (!(error instanceof RpcError) || error.code !== DomainErrorCode.PairingRefused) {
    return undefined;
  }
  const raw = (error.data as { reason?: unknown } | undefined)?.reason;
  const reason =
    typeof raw === "string" && Object.hasOwn(PAIRING_REFUSED_MESSAGES, raw)
      ? (raw as PairingRefusedReason)
      : "unknown";
  return new PairingRefused(reason, PAIRING_REFUSED_MESSAGES[reason]);
}

/**
 * Pair this device. Tries each address in the payload's order and stops at the
 * first that COMPLETES the exchange (a wrong code is a real answer — `used` from
 * one daemon means the claim exists for the whole computer, so a second address
 * cannot help and the error is returned as-is).
 */
export async function pairDevice(options: PairDeviceOptions): Promise<PairDeviceResult> {
  const failures: unknown[] = [];
  for (const address of options.payload.addresses) {
    try {
      return await pairAt(address, options);
    } catch (error) {
      // A refusal is the DAEMON's answer, not an unreachable address: the
      // claim it reports is per computer, so retrying another address would
      // only repeat it — and a `too_many_attempts` must not be spent again.
      if (error instanceof PairingRefused) {
        throw error;
      }
      failures.push(error);
    }
  }
  // Nothing answered: surface the LAST failure (the most recent attempt's
  // reason — a TLS error on one address, a wrong pinned key on another).
  throw failures.length === 1
    ? failures[0]
    : new ChannelError(
        "unreachable",
        `no pairing address answered (${options.payload.addresses.length} tried)`,
      );
}

async function pairAt(address: string, options: PairDeviceOptions): Promise<PairDeviceResult> {
  const factory = secureChannelFactory(options.dial(address), {
    staticKey: options.deviceKey,
    remoteStatic: options.payload.key,
    random: options.random,
  });
  // A dial failure is already the transport's own `ChannelError`, and
  // `secureChannelFactory` maps a failed handshake itself (`denied` →
  // `unauthorized`, common/terminal for a wrong pinned key — F23).
  const secure = await factory();
  const timeoutMs = options.requestTimeoutMs ?? 30_000;
  // NO peer-wide deadline: it would cap `device/pair` too, which waits on a
  // human whose window is 5 minutes (`PAIRING_TTL_MS`). A 30 s cap there fails
  // a phone whose user took 31 s while the computer's terminal keeps asking, so
  // a later `y` registers a device that already reported failure. The exchange's
  // deadline is the DAEMON's (expiry → `timeout`); a dead channel still rejects
  // the pending request, because `RpcPeer` rejects on close.
  const peer = new RpcPeer(secure, {
    onRequest: async () => {
      throw new RpcError(DomainErrorCode.Unauthorized, "the daemon does not ask during pairing");
    },
    onNotification: () => {},
  });
  // `initialize` is a HANDSHAKE, not a human's decision: it keeps its own
  // deadline, or a daemon that accepts the socket and then says nothing would
  // hang the pairing screen.
  const initAbort = new AbortController();
  const initTimer = setTimeout(() => initAbort.abort(), timeoutMs);
  (initTimer as { unref?: () => void }).unref?.();
  try {
    const init = (await peer.request(
      Method.Initialize,
      {
        protocolVersion: PROTOCOL_VERSION,
        clientCapabilities: {},
        clientInfo: { name: "tentacle-app", version: "0" },
      },
      { signal: initAbort.signal },
    )) as { protocolVersion: number };
    clearTimeout(initTimer);
    if (options.onCompare) {
      // The SAS both screens must agree on: the payload's computer key and OUR
      // key (the one this handshake authenticated as).
      const sas = pairingSas(options.payload.key, publicKeyOf(options.deviceKey));
      await options.onCompare(sas, { protocolVersion: init.protocolVersion });
    }
    const params: DevicePairParams = { code: options.payload.code, name: options.name };
    const result = await peer.request(Method.DevicePair, params);
    return result as PairDeviceResult;
  } catch (error) {
    const refused = pairingRefusedFrom(error);
    if (refused !== undefined) {
      throw refused;
    }
    throw error;
  } finally {
    clearTimeout(initTimer);
    // One-shot: the socket goes whatever happened. A failed pairing must not
    // leave a pairing-only connection open on the computer.
    peer.close();
  }
}
