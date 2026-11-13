/**
 * `PairHandler` — the daemon side of pairing (docs/feat/device-pairing.md 9c,
 * Design "Pairing exchange").
 *
 * It answers exactly one RPC, `device/pair`, on a PAIRING connection (the
 * principal the `/e2e` route gives an unregistered key while a window is open).
 * The sequence, and why each step is where it is:
 *
 * 1. find the window for the code — a fresh read, unexpired, its `pair` alive.
 *    A wrong code, an expired window, a dead `pair` and an invalid alphabet are
 *    ONE answer (`invalid_code`): the peer is unauthenticated, so the daemon
 *    tells it nothing about which windows exist, and the human's next action is
 *    the same in every case (F1/F5);
 * 2. CLAIM the window for the CHANNEL's key — `<sid>.claim.json` created with
 *    `wx`, one claim for the whole computer. The key is this connection's
 *    `remoteStatic` (bound in the constructor from the resolved
 *    `SecureChannel`), never a parameter: `device/pair`'s params have no key
 *    field at all (F18);
 * 3. wait for the human. `pair` writes the registry entry FIRST and then the
 *    decision, so a `pair` that exits between the two still succeeds (F3): the
 *    registry is the authority, the decision breaks a tie the other way
 *    (`declined`);
 * 4. answer `{ deviceId, computer }`, or `PairingRefused` with a reason.
 *
 * No lock is held across the wait, and `RpcPeer` dispatches requests
 * concurrently (AGENTS §7): a pairing held open for minutes blocks nothing
 * else, on this connection or any other.
 *
 * The attempt cap is per CONNECTION (`PAIRING_MAX_ATTEMPTS`), which is why the
 * handler is per connection too: five wrong codes answer `too_many_attempts`
 * and then close the socket (F6/F16).
 */
import type { DevicePairParams, DevicePairResult, PairingRefusedReason } from "@tentacle/protocol";
import { DomainErrorCode, RpcError } from "@tentacle/transport";
import {
  type DeviceIdentity,
  claimPairing,
  deviceIdOf,
  findPairing,
  readClaim,
  readPairingDecision,
  readRegistry,
} from "./device-store.ts";

/** Wrong codes one pairing connection may send before it is closed (F6). */
export const PAIRING_MAX_ATTEMPTS = 5;
/** How often the wait re-reads the decision and the registry. */
export const PAIRING_POLL_MS = 100;

export interface PairHandlerOptions {
  /** The computer's config dir: `<configDir>/devices/` holds the windows. */
  readonly configDir: string;
  /** The computer's identity — the result's `computer`, and the SAS's own key. */
  readonly identity: DeviceIdentity;
  /** This connection's authenticated peer key (`SecureChannel.remoteStatic`). */
  readonly remoteStatic: Uint8Array;
  /** Injectable clock: every expiry is judged against it only (F24). */
  readonly now?: () => number;
  /** Injectable pid liveness (a window whose `pair` died is not usable, F2). */
  readonly alive?: (pid: number) => boolean;
  /** How often the wait re-reads (tests shorten it). */
  readonly pollMs?: number;
  /** Operator lines: `pairing-refused <id8> <reason> attempts=<n>`, `pairing-done <id8>`. */
  readonly onAudit?: (line: string) => void;
  /** Close this connection — the attempt cap's last resort (F6/F16). */
  readonly close?: () => void;
}

/** What one attempt produced: the wire result, or the refusal reason. */
export type PairOutcome =
  | { readonly ok: true; readonly result: DevicePairResult }
  | { readonly ok: false; readonly reason: PairingRefusedReason };

export class PairHandler {
  private readonly options: PairHandlerOptions;
  private attempts = 0;
  /**
   * The window THIS connection already claimed. A retry of the same code from
   * the same connection is idempotent, not `used`: a phone that lost the answer
   * without losing its socket must not be told its own claim is a stranger's.
   */
  private claimed: string | undefined;

  constructor(options: PairHandlerOptions) {
    this.options = options;
  }

  /** Wrong codes this connection has sent so far (the cap is `PAIRING_MAX_ATTEMPTS`). */
  get attemptCount(): number {
    return this.attempts;
  }

  /**
   * `device/pair`: `params` are peer-chosen (a code and a display name); the key
   * that will be registered is this connection's authenticated `remoteStatic`.
   * `signal` aborts the wait when the peer goes away (`RpcPeer` aborts an
   * inbound handler on close), so a phone that hung up mid-pairing does not
   * leave a poll loop behind.
   */
  async pair(params: DevicePairParams, signal?: AbortSignal): Promise<PairOutcome> {
    const now = this.now();
    const remoteKey = this.options.remoteStatic;
    // `findPairing` hashes the code and THROWS on a bad alphabet (9a Review N3:
    // it was written for our own `pair`, never for peer input). A peer's code
    // is therefore caught here and answered as a refusal, never as an internal
    // error — the reason is the attempt's, not a crash's.
    const session = this.safely(() =>
      findPairing(this.options.configDir, {
        code: params.code,
        now,
        ...(this.options.alive ? { alive: this.options.alive } : {}),
      }),
    );
    if (session === undefined) {
      return this.spend("invalid_code", remoteKey);
    }
    if (this.claimed !== session.sid) {
      const claim = claimPairing(this.options.configDir, {
        sid: session.sid,
        deviceKey: remoteKey,
        name: params.name,
        now,
        ...(this.options.alive ? { alive: this.options.alive } : {}),
      });
      if (!claim.ok) {
        return this.spend(
          claim.reason === "used"
            ? "used"
            : claim.reason === "gone"
              ? "invalid_code"
              : // An unreadable store or a vanished identity: nothing can be
                // written, so nothing can be paired (F14 — fail closed).
                "declined",
          remoteKey,
        );
      }
      this.claimed = session.sid;
    }
    // The claim is OURS: the human decides, and the registry write is `pair`'s
    // (it holds the lock, and it is the process the human is talking to).
    const decided = await this.waitForDecision(session.sid, remoteKey, session.expiresAt, signal);
    if (!decided.ok) {
      return decided;
    }
    const id = deviceIdOf(remoteKey);
    this.options.onAudit?.(`pairing-done ${id.slice(0, 8)}`);
    return {
      ok: true,
      result: {
        deviceId: id,
        computer: {
          // The identity this connection was admitted against (`authorize`
          // resolved it before message 2); a `devices reset` meanwhile closes
          // device connections, and this one holds no session to lose.
          id: deviceIdOf(this.options.identity.publicKey),
          name: this.options.identity.name,
        },
      },
    };
  }

  /**
   * `pair`'s answer. The REGISTRY decides success (it is written first, F3), so
   * a decision file that never made it to disk — or a `pair` that only ever
   * wrote the entry — still pairs; `accepted: false` declines, and the window's
   * expiry (or its files disappearing) is `timeout`.
   */
  private async waitForDecision(
    sid: string,
    remoteKey: Uint8Array,
    expiresAt: number,
    signal?: AbortSignal,
  ): Promise<
    { readonly ok: true } | { readonly ok: false; readonly reason: PairingRefusedReason }
  > {
    const id = deviceIdOf(remoteKey);
    const pollMs = this.options.pollMs ?? PAIRING_POLL_MS;
    for (;;) {
      if (signal?.aborted === true) {
        // The peer hung up: nobody can be told the answer, and its window is
        // the human's to answer (`pair` clears it on exit). Stop polling.
        return { ok: false, reason: "timeout" };
      }
      if (this.registryHas(id)) {
        return { ok: true };
      }
      const decision = readPairingDecision(this.options.configDir, sid);
      if (decision === false) {
        return { ok: false, reason: "declined" };
      }
      if (decision === true) {
        // Accepted, but the registry (written BEFORE it) does not list the key:
        // a human's mess, or a disk that lost the write. One bounded re-read,
        // then refuse — a decision alone authorises nobody (never fail open).
        await this.sleep(pollMs);
        return this.registryHas(id) ? { ok: true } : { ok: false, reason: "declined" };
      }
      if (this.now() >= expiresAt) {
        return { ok: false, reason: "timeout" };
      }
      if (readClaim(this.options.configDir, sid) === undefined) {
        // `pair` cleaned the window up (Ctrl+C, exit handler): nothing to wait for.
        return { ok: false, reason: "timeout" };
      }
      await this.sleep(pollMs);
    }
  }

  private registryHas(id: string): boolean {
    const registry = readRegistry(this.options.configDir);
    // An unreadable registry lists nobody: it can only refuse, never admit (F14).
    return registry.ok && registry.registry.devices.some((d) => d.id === id);
  }

  /**
   * Count a refused attempt and answer it. At the cap the socket is closed —
   * in a MACROTASK, so the `PairingRefused` frame this handler returns into is
   * sent first (`RpcPeer` writes it in a microtask continuation; closing in a
   * microtask here would beat it to the wire and the peer would only see a
   * dropped socket).
   */
  private spend(reason: PairingRefusedReason, remoteKey: Uint8Array): PairOutcome {
    this.attempts++;
    this.options.onAudit?.(
      `pairing-refused ${deviceIdOf(remoteKey).slice(0, 8)} ${reason} attempts=${this.attempts}`,
    );
    if (this.attempts >= PAIRING_MAX_ATTEMPTS) {
      const close = this.options.close;
      if (close) {
        setTimeout(close, 0);
      }
      return { ok: false, reason: "too_many_attempts" };
    }
    return { ok: false, reason };
  }

  private safely<T>(read: () => T): T | undefined {
    try {
      return read();
    } catch {
      // A malformed code is a refusal, never a crash (9a Review N3).
      return undefined;
    }
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/** The `PairingRefused` `RpcError` — the ONE place an outcome becomes an error. */
export function pairingRefusedError(reason: PairingRefusedReason): RpcError {
  const message =
    reason === "invalid_code"
      ? "the pairing code is wrong, expired or no longer usable — run `tentacle pair` again"
      : reason === "used"
        ? "another device already used this pairing code — run `tentacle pair` again"
        : reason === "declined"
          ? "the pairing was declined on the computer"
          : reason === "timeout"
            ? "the pairing window closed before the computer answered"
            : reason === "too_many_attempts"
              ? "too many wrong pairing codes on this connection"
              : "this connection is already paired";
  return new RpcError(DomainErrorCode.PairingRefused, message, { reason });
}
