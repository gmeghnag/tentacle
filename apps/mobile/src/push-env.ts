/**
 * Which APNs environment this build's tokens belong to
 * (docs/fix/mobile-push-not-registered.md, root cause 1).
 *
 * Apple's rule: a token is valid ONLY against the host that matches the RUNNING
 * BINARY's signed `aps-environment` entitlement. Deriving it from anything else
 * — the JS bundle mode most of all — is a silent `400 BadDeviceToken` at APNs,
 * which the relay reports as `gone` and the daemon acts on by DELETING the
 * registration. A Release archive exported `method: debugging` is exactly that
 * combination: a production bundle signed with the sandbox entitlement.
 *
 * So this maps the SIGNATURE's answer (`embedded.mobileprovision`, read by
 * `expo-application`) and nothing else. Pure and React-free, per AGENTS §7.
 */
import type { PushEnvironment } from "@tentacle/protocol";

/**
 * The wire environment of one `aps-environment` entitlement value.
 *
 * `null` is not "unknown": it is what the getter answers when the bundle holds
 * no `embedded.mobileprovision` — an App Store/TestFlight install, which Apple
 * re-signs at the store. Those tokens are production ones (and the simulator,
 * the other `null` case, has no token at all, so nothing is ever sent from it).
 */
export function pushEnvironmentOfAps(
  apsEnvironment: "development" | "production" | null,
): PushEnvironment {
  return apsEnvironment === "development" ? "sandbox" : "production";
}
