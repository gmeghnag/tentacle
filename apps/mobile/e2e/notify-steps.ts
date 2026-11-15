/**
 * docs/feat/mobile-notifications.md slice N8: the TWO hooks the notification
 * flows need, as pure functions over injected effects (so a `bun test` pins them
 * and the flow only reports).
 *
 *  - **`seal-push`** seals one `PushMessage` to the simulator's registered push
 *    key with the computer's static key — the same `sealPush` the daemon uses —
 *    and hands the payload to `simctl push`. It exists because a flow must be
 *    able to place an ASK of its choosing (a reply-able one, a forged one), which
 *    a real turn cannot be relied on to produce on cue.
 *  - **`notify-respond`** injects a notification RESPONSE into the app's
 *    dispatcher (Owner Q7: a dev-build-only hook). Maestro cannot long-press a
 *    system banner reliably, so the action button a flow "taps" is this hook; what
 *    the app then does is the real path (Face ID prompt included).
 *
 * Neither is a test-only shortcut in the app's logic: both end in the SAME
 * `dispatchNotification` / sealing chain production uses.
 */
import { encodeBase64Url } from "@tentacle/protocol";
import type { PushMessage } from "@tentacle/protocol";
import { type SealedPush, sealPush } from "@tentacle/transport/push";

/** The payload shape APNs carries (`aps` + the one custom key). */
export interface NotificationPayload {
  readonly aps: Record<string, unknown>;
  readonly tp: Record<string, unknown>;
}

/** Seal one plaintext for the device's push key. Deterministic: `rng` is injected. */
export function sealPushMessage(
  message: PushMessage,
  computerStaticPrivate: Uint8Array,
  devicePushPublic: Uint8Array,
  rng: (length: number) => Uint8Array,
): SealedPush {
  const plaintext = new TextEncoder().encode(JSON.stringify(message));
  return sealPush(plaintext, computerStaticPrivate, devicePushPublic, rng);
}

/**
 * The APNs payload for a sealed push: the relay's uniform outer `aps` (task 16
 * P4: `mutable-content: 1` so the NSE runs) and the envelope. `overrides` lets a
 * flow place a HOSTILE `aps` (F5: an added `category`, a removed
 * `mutable-content`) — the app must survive it either way.
 */
export function payloadFor(
  sealed: SealedPush,
  overrides: Record<string, unknown> = {},
): NotificationPayload {
  return {
    aps: {
      alert: { title: "tentacle", body: "Open tentacle to see what's new" },
      "mutable-content": 1,
      sound: "default",
      ...overrides,
    },
    tp: {
      v: 1,
      k: sealed.keyId,
      e: encodeBase64Url(sealed.enc),
      c: encodeBase64Url(sealed.ciphertext),
    },
  };
}

/** The response `notify-respond` injects: the action id, the tap's `userInfo` and any reply text. */
export interface InjectedResponse {
  readonly actionId: string;
  readonly userInfo: unknown;
  readonly userText?: string;
}
