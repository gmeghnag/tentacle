import type { PushEnvironment } from "@tentacle/protocol";
import { getIosPushNotificationServiceEnvironmentAsync } from "expo-application";
import { getRandomBytes } from "expo-crypto";
/**
 * `expo-notifications` behind the app's push seams (docs/feat/mobile-push.md
 * slice P9, Design 7; decision 19). The ONE native import of the push path, kept
 * to wiring so `push-registration.ts` / `push-key.ts` stay pure and testable
 * (AGENTS §7).
 *
 * Two decisions are visible here:
 *
 *  - **`getDevicePushTokenAsync`, never `getExpoPushTokenAsync`.** The raw APNs
 *    token (lowercase hex, P0(d)) goes straight to the paired computer over
 *    Noise; Expo's push service is never contacted (decision 19). For the same
 *    reason `setAutoServerRegistrationEnabledAsync` is never called: importing
 *    the package installs that machinery's token LISTENER, which only acts once
 *    a registration is enabled — and it never is.
 *  - **The environment follows the SIGNATURE, never the bundle.** A token is
 *    valid only against the APNs host matching the running binary's signed
 *    `aps-environment` entitlement. Reading the bundle mode instead — what this
 *    did until `fix/mobile-push-not-registered` — declared `production` for a
 *    sandbox-signed build (a Release archive exported `method: debugging`),
 *    which APNs answers with `400 BadDeviceToken`; the relay reports that as
 *    `gone` and the daemon DELETES the registration. The mapping is the pure
 *    `pushEnvironmentOfAps` (`push-env.ts`), and a read that fails sends
 *    NOTHING: a guessed environment is the bug itself.
 */
import * as Notifications from "expo-notifications";
import { pushEnvironmentOfAps } from "./push-env.ts";
import { ensurePushKeypair } from "./push-key.ts";
import type { PushFacts, PushPermission } from "./push-registration.ts";
import { KEYCHAIN_ACCESSIBLE, pushKeychain } from "./secure-kv.ts";

/** `expo-secure-store`'s `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` (the class every write carries). */
export const PUSH_KEYCHAIN_ACCESSIBLE = KEYCHAIN_ACCESSIBLE;

/**
 * This build's signed APNs environment, as a wire value — `undefined` when it
 * cannot be read at all (no native half: a simulator build of a non-Xcode
 * workflow), which the caller reports as "no facts" rather than guessing.
 */
async function signedPushEnvironment(): Promise<PushEnvironment | undefined> {
  try {
    return pushEnvironmentOfAps(await getIosPushNotificationServiceEnvironmentAsync());
  } catch {
    return undefined;
  }
}

/**
 * The OS's notification permission, in this app's vocabulary. `unavailable` is
 * what a build with no push entitlement (a plain simulator build) reports:
 * shown like a denial, and never retried — nothing will change it.
 *
 * `canAskAgain: false` is NOT a third state here: iOS shows the prompt once, so
 * a denial is terminal from the app's side either way and the row's copy sends
 * the person to iOS Settings. Keeping it out of the vocabulary is what stops a
 * caller from "retrying" a prompt the OS will not show.
 */
export function pushPermissionOf(status: {
  readonly status: string;
  readonly canAskAgain?: boolean;
}): PushPermission {
  if (status.status === "granted") {
    return "granted";
  }
  return status.status === "undetermined" ? "undetermined" : "denied";
}

/** The OS permission now, without prompting. */
export async function readPermission(): Promise<PushPermission> {
  try {
    return pushPermissionOf(await Notifications.getPermissionsAsync());
  } catch {
    // A build where the module is missing (a simulator without the native half).
    return "unavailable";
  }
}

/** Ask the OS once (a prompt iOS shows at most once per install anyway). */
export async function requestPermission(): Promise<PushPermission> {
  try {
    return pushPermissionOf(await Notifications.requestPermissionsAsync());
  } catch {
    return "unavailable";
  }
}

/**
 * Whether the OS has already asked (so the prompt is not re-shown): iOS keeps
 * `undetermined` until its one prompt has been answered.
 */
export async function readAsked(): Promise<boolean> {
  try {
    const permissions = await Notifications.getPermissionsAsync();
    return permissions.status !== "undetermined";
  } catch {
    return false;
  }
}

/**
 * This phone's push key plus the APNs token, as one `PushFacts` — or `undefined`
 * when this build cannot produce a token (no entitlement, a simulator without
 * push support), which the runner shows as "nothing sent", never as an error.
 *
 * The token is RE-READ on every call on purpose: iOS rotates it (F11), and the
 * registration fingerprint is what turns a rotation into a re-register.
 */
export async function readPushFacts(): Promise<PushFacts | undefined> {
  const keypair = await ensurePushKeypair({
    store: pushKeychain,
    random: (length) => getRandomBytes(length),
    keychainAccessible: PUSH_KEYCHAIN_ACCESSIBLE,
  });
  // BEFORE the token: an environment this build cannot state is a registration
  // that could only ever be refused, so nothing is sent (and no token read).
  const env = await signedPushEnvironment();
  if (env === undefined) {
    return undefined;
  }
  let token: string;
  try {
    const devicePushToken = await Notifications.getDevicePushTokenAsync();
    // `data` is the raw token: iOS's own `NotificationsAppDelegateSubscriber`
    // hex-encodes the bytes before handing them over (P0(d)).
    token = String(devicePushToken.data).toLowerCase();
  } catch {
    return undefined;
  }
  if (!/^[0-9a-f]{64,200}$/.test(token)) {
    // A token shape the wire refuses: report "no token" rather than send a
    // registration the daemon answers with `InvalidParams` (F26).
    return undefined;
  }
  return { token, env, key: keypair.publicKey };
}
