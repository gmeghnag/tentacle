/**
 * `device/pair` — a NEW device proves the one-time pairing code INSIDE the
 * confirmed secure channel (docs/feat/device-pairing.md 9c, Design "Pairing
 * exchange").
 *
 * The code never travels in Noise message 1 (that is replayable —
 * `docs/feat/e2e-channel.md`), and the device's key is NEVER a parameter: the
 * daemon takes it from the channel's authenticated `remoteStatic` (F18). So
 * there is nothing here to smuggle: `params` are the secret the human typed
 * into the phone (a 50-bit one-time code) and the name the human is asked to
 * confirm — both peer-chosen, both bounded.
 *
 * Additive on the wire, no `PROTOCOL_VERSION` bump: an older daemon has no
 * `/e2e` route at all (the phone's dial is 401'd), so no mixed-version
 * mid-session failure exists. The schemas are STRIP objects (AGENTS §7), so a
 * later additive field does not break this build.
 */
import { z } from "zod";
import { PAIRING_CODE_LENGTH, PAIRING_COMPUTER_NAME_MAX } from "./pairing.ts";
import { line } from "./text-line.ts";

/**
 * A device id: the first 16 hex of SHA-256(device public key) — the registry's
 * key (`device-store.ts`'s `deviceIdOf`, which owns the definition; the wire
 * only needs its shape).
 */
export const DEVICE_ID_RE = /^[0-9a-f]{16}$/;

/**
 * `device/pair` params. `code` is the length-checked one-time code (10 Crockford
 * base32 characters, case-insensitive: the handler normalises and refuses a bad
 * alphabet as `invalid_code` rather than as invalid params, so a phone that
 * mistyped gets the same answer as one with a stale code). `name` is a display
 * line: control characters are refused outright, so nothing ANSI or bidi ever
 * reaches a terminal or the registry (F17).
 */
export const DevicePairParamsSchema = z.object({
  code: z.string().length(PAIRING_CODE_LENGTH),
  name: line(PAIRING_COMPUTER_NAME_MAX),
});
export type DevicePairParams = z.infer<typeof DevicePairParamsSchema>;

/**
 * Who accepted the pairing: this computer's own id and display name, so the app
 * can show WHICH computer it just paired with (one app, many computers —
 * decision 3).
 */
export const DeviceComputerSchema = z.object({
  id: z.string().regex(DEVICE_ID_RE),
  name: line(PAIRING_COMPUTER_NAME_MAX),
});
export type DeviceComputer = z.infer<typeof DeviceComputerSchema>;

/** `device/pair`'s result: the new device's id, and the computer that took it. */
export const DevicePairResultSchema = z.object({
  deviceId: z.string().regex(DEVICE_ID_RE),
  computer: DeviceComputerSchema,
});
export type DevicePairResult = z.infer<typeof DevicePairResultSchema>;

/**
 * Why the daemon refused a `device/pair` (`PairingRefused`'s `data.reason`). A
 * client branches on the reason and never on text. Adding one is additive on
 * the wire (an older client reads an unknown reason as a generic refusal), so
 * this is a TS union, not an enum a peer must know.
 */
export type PairingRefusedReason =
  /** No usable window for that code: wrong code, expired, or its `pair` died. */
  | "invalid_code"
  /** Someone already claimed this one-time code (F1/F5): run `pair` again. */
  | "used"
  /** The human answered no (or the registry never listed the key). */
  | "declined"
  /** The window closed while this device waited. */
  | "timeout"
  /** Five wrong codes on one connection: it is closed (F6/F16). */
  | "too_many_attempts"
  /** This connection is already a device (or a token client): nothing to pair. */
  | "already_paired";

/** Every reason this build knows (a membership test, for forward compatibility). */
export const PAIRING_REFUSED_REASONS: readonly PairingRefusedReason[] = [
  "invalid_code",
  "used",
  "declined",
  "timeout",
  "too_many_attempts",
  "already_paired",
];

/** Narrow a `data.reason` off the wire (an unknown one is NOT a known reason). */
export function isPairingRefusedReason(value: unknown): value is PairingRefusedReason {
  return (
    typeof value === "string" && (PAIRING_REFUSED_REASONS as readonly string[]).includes(value)
  );
}

/**
 * The `data` of a `PairingRefused` error. A bounded FREE string, not an enum: a
 * newer daemon's new reason must not make an older client reject the whole
 * error payload (it reads an unknown one as `unknown`).
 */
export const PairingRefusedDataSchema = z.object({
  reason: z.string().min(1).max(64),
});
export type PairingRefusedData = z.infer<typeof PairingRefusedDataSchema>;
