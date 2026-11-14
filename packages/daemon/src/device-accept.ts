/**
 * The device path, independent of how the frames reach it
 * (docs/feat/mobile-relay.md R3): run the Noise responder on a
 * `DuplexChannel`, and only once it RESOLVES build the (unchanged)
 * `Connection` on the resolved channel.
 *
 * It used to live inside `ws-server`'s `openDevice`, coupled to a Bun socket
 * only as an identity key: `pending.set(ws, …)`, `connections.set(ws, …)`,
 * `ws.data.release = …`. Nothing that authenticates or builds state ever
 * touched the socket, so every one of those is a caller-supplied hook here
 * (`onSettled`, `onConnection`, the returned `release`) and the direct `/e2e`
 * route behaves exactly as before — its own tests are the proof (AGENTS §9).
 * That is what makes the mobile relay "one more transport": its accept leg is
 * a `DuplexChannel` too, and no second authentication or session path exists
 * (§7 one session path).
 *
 * Everything the device route promises stays here: a replayed message 1 builds
 * nothing and records nothing (F4/P2), a revoke closes the live connection
 * through the authority's handle, a pairing connection lives only while a
 * pairing window does (F16), and a socket that closed between the confirm and
 * the build leaves no orphan `Connection` (F22).
 */
import type { DuplexChannel } from "@tentacle/transport";
import { type AuthorizeVerdict, noiseResponder, systemRandom } from "@tentacle/transport/noise";
import { Connection, type ConnectionPrincipal } from "./connection.ts";
import type { DeviceAllow, DeviceAuthority, DeviceClose } from "./device-authority.ts";
import { hasLivePairing, touchSeen } from "./device-store.ts";
import { PairHandler } from "./pairing-handler.ts";
import type { SessionHost } from "./session-host.ts";

/** How often a pairing-only connection checks its window is still open (a poll, not a deadline). */
export const PAIRING_CHECK_MS = 1_000;
/** Max inbound frame size accepted before parsing, unless the caller overrides it. */
export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024; // 8 MiB

export interface AcceptDeviceDeps {
  /** The authority the handshake asks over the device store. */
  readonly authority: DeviceAuthority;
  readonly sessionHost: SessionHost;
  /**
   * Has the channel already closed? The F22 race check: a channel closed
   * between the confirm and the build must not leave an attached `Connection`
   * (the channel's close handler already fired and will never call back).
   * Required, not optional: a caller that cannot answer would silently keep the
   * orphan this guards against.
   */
  readonly isClosed: () => boolean;
  readonly onError?: (error: Error) => void;
  /** One line per handshake outcome, for the operator. */
  readonly onAudit?: (line: string) => void;
  readonly maxFrameBytes?: number;
  /** How often a pairing-only connection re-checks its window (`PAIRING_CHECK_MS`). */
  readonly pairingCheckMs?: number;
  /**
   * Called EXACTLY once, when the handshake reached a terminal outcome — no
   * identity, resolved, or rejected — whether or not it was before or after the
   * channel closed. The caller's own bookkeeping (the `serve` route's pending
   * map and handshake-limiter slot) hangs here, so a socket that never answers
   * can never hold a slot forever.
   */
  readonly onSettled?: () => void;
  /**
   * The connection the handshake built, handed to the caller so it can close it
   * when its own transport goes away (the direct route's socket close does
   * that: `Connection.close()` is what detaches its sessions).
   */
  readonly onConnection?: (connection: Connection) => void;
}

/** The handle returned by `acceptDevice`. */
export interface DeviceAccept {
  /**
   * Teardown once the transport is gone: stop the pairing watcher and drop the
   * authority's handle, so a later revoke cannot touch this connection, and so
   * nothing (a timer included) outlives the transport. Safe to call at any time
   * and more than once: the work is idempotent, but it is not a latch — a call
   * made BEFORE the handshake resolves only does what exists at that moment,
   * and the F22 close-up at the build does the rest (R3 review 1).
   */
  release(): void;
}

/**
 * Accept one device connection on `channel`: the Noise handshake IS the
 * authentication (no token, no Origin check — a phone sends an Origin).
 */
export function acceptDevice(channel: DuplexChannel, deps: AcceptDeviceDeps): DeviceAccept {
  const { authority } = deps;
  const identity = authority.staticKey();
  // The whole identity, not just its private key: the pairing result names the
  // computer (`{ id, name }`), and the SAS is computed from its key.
  const computer = authority.identity();
  if (identity === undefined || computer === undefined) {
    // No usable identity (an unreadable store, F14/F26): nothing can be
    // authenticated, so the channel is closed rather than left half-open — and
    // the caller's slot goes back HERE, since no handshake will ever settle to
    // release it. Skipping this leaks a slot per dial and 429s every device
    // until a restart (production `maxConcurrent` is 32).
    deps.onAudit?.("e2e-no-identity");
    deps.onSettled?.();
    channel.close();
    return { release: () => {} };
  }
  let settled = false;
  // Every outcome ends the caller's bookkeeping EXACTLY once: an unanswered
  // channel must not hold a slot forever.
  const settle = (): void => {
    if (settled) return;
    settled = true;
    deps.onSettled?.();
  };
  // The verdict of the handshake that actually completed: `authorize` runs on
  // every message 1 and a revoke could land between the two calls, so the
  // decision is captured rather than asked for again.
  let admitted: DeviceAllow | undefined;
  // Set only for a pairing connection: its window watcher's stopper.
  let stopWatcher: (() => void) | undefined;
  // The teardown's work is IDEMPOTENT (clearing an already-cleared stopper,
  // unregistering a handle the authority's set no longer holds), so it needs no
  // once-latch: a latch would be wrong here, because a `release()` that arrives
  // BEFORE the handshake resolves (the caller's socket `close` handler does
  // exactly that) would then swallow the later F22 close-up, and the handle the
  // build registers would be unregistered by nobody — the authority would keep
  // a dead handle for the process's life, and a pairing watcher would keep
  // auditing `pairing-closed` every tick (R3 review 1).
  let built: { connection: Connection; handle: DeviceClose; id?: string } | undefined;
  const teardown = (): void => {
    stopWatcher?.();
    stopWatcher = undefined;
    if (built?.id !== undefined) {
      authority.unregister(built.id, built.handle);
    }
  };
  noiseResponder(channel, {
    staticKey: identity,
    random: systemRandom,
    authorize: (remoteStatic) => {
      const verdict = authority.authorize(remoteStatic);
      if (verdict !== false) admitted = verdict;
      return verdict as AuthorizeVerdict;
    },
    onViolation: (error) => deps.onAudit?.(`e2e-violation ${error.kind}`),
  }).then(
    (secure) => {
      settle();
      const verdict = admitted;
      if (verdict === undefined) {
        // Resolved with no allow recorded: only a bug here could do that.
        channel.close();
        return;
      }
      const principal: ConnectionPrincipal =
        verdict.kind === "device"
          ? { kind: "device", id: verdict.id }
          : {
              kind: "pairing",
              // The handler is per CONNECTION: its attempt cap (5 wrong codes)
              // belongs to the socket, and the key it registers is the one THIS
              // handshake authenticated (F18: `device/pair`'s params carry no
              // key at all).
              pair: new PairHandler({
                configDir: authority.configDir,
                identity: computer,
                remoteStatic: secure.remoteStatic,
                ...(deps.onAudit ? { onAudit: deps.onAudit } : {}),
                close: () => channel.close(),
              }),
            };
      // Built on the RESOLVED secure channel, exactly as the plain route builds
      // it on the raw socket: `Connection` is unchanged and never learns there
      // was a handshake (§7 one session path).
      const connection = new Connection(secure, deps.sessionHost, deps.onError, {
        maxFrameBytes: deps.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
        principal,
      });
      // ONE handle for this connection: the authority holds it for a revoke,
      // and every teardown path unregisters this same object, so a revoke's
      // later `unregister` can never touch a different connection.
      const handle: DeviceClose = {
        close: () => {
          connection.close();
          channel.close();
        },
      };
      built = {
        connection,
        handle,
        ...(verdict.kind === "device" ? { id: verdict.id } : {}),
      };
      deps.onConnection?.(connection);
      if (verdict.kind === "device") {
        authority.register(verdict.id, handle);
        touchSeen(authority.configDir, verdict.id);
        deps.onAudit?.(`device-open ${verdict.id.slice(0, 8)}`);
      } else {
        // A pairing connection lives only as long as a pairing window does
        // (F16): the check is a poll, so an expiry that `pair` failed to clean
        // up still closes it, and `pair`'s exit handler (which removes the
        // window) closes it within a check. `hasLivePairing` is the
        // side-effect-free read (9a Review N3), never `findPairing`.
        stopWatcher = watchPairingWindow(
          authority.configDir,
          deps,
          handle,
          // A connection answering a claim it holds is never closed by the
          // watcher (F3): see `watchPairingWindow`.
          () => (principal.kind === "pairing" ? principal.pair.holdingClaim : false),
        );
        deps.onAudit?.("pairing-open");
      }
      // The channel closed between the confirm and this point (F22): the
      // channel's close already fired and will never call back, so the
      // connection must be closed here or it would stay attached forever.
      if (deps.isClosed()) {
        handle.close();
        teardown();
        return;
      }
    },
    (error: { kind?: string }) => {
      settle();
      deps.onAudit?.(
        error.kind === "denied" ? "device-denied" : `e2e-violation ${String(error.kind)}`,
      );
    },
  );
  return { release: teardown };
}

/**
 * A pairing connection lives only while a pairing window does (F16/F2): poll the
 * store and close the connection when no usable window is left — the window
 * expired, or `pair` cleaned it up (Ctrl+C, its exit handler). `hasLivePairing`
 * is the side-effect-free read (9a Review N3); the OTHER window on a computer
 * with two `pair` windows keeps the connection open, which is right: any live
 * window may still be the one this peer scanned.
 *
 * It never closes a connection that is ANSWERING a claim it holds
 * (`holdingClaim`): `pair` writes the registry and THEN removes its window, so
 * the winning exchange's last moment is exactly a moment with no live window —
 * closing there would report "the connection closed" for a device that IS
 * registered, breaking F3. That connection is the handler's to end (registry
 * first, then the decision, then the expiry), and the next tick closes the
 * socket normally if nothing is left.
 *
 * Returns the stopper, called on every teardown path (so no timer outlives a
 * connection).
 */
function watchPairingWindow(
  configDir: string,
  deps: Pick<AcceptDeviceDeps, "onAudit" | "pairingCheckMs">,
  handle: DeviceClose,
  holdingClaim: () => boolean,
): () => void {
  const watcher = setInterval(() => {
    if (hasLivePairing(configDir) !== undefined) {
      return;
    }
    if (holdingClaim()) {
      return;
    }
    deps.onAudit?.("pairing-closed");
    handle.close();
  }, deps.pairingCheckMs ?? PAIRING_CHECK_MS);
  // Housekeeping, never a reason for the process to stay alive (`serve`'s
  // listener decides that; `bun test` must be able to exit).
  (watcher as { unref?: () => void }).unref?.();
  return () => clearInterval(watcher);
}
