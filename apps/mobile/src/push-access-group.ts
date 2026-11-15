/**
 * docs/feat/mobile-notifications.md Design 6 / plan C1: the Keychain access
 * groups, in ONE place, with the Team ID in front of them.
 *
 * Two rules from iOS's Keychain services, each of which the shipping config
 * broke (fix round 1, findings #3 and #4):
 *
 *  1. **`kSecAttrAccessGroup` must match a BUILT entitlement string exactly.**
 *     The build variable `$(AppIdentifierPrefix)` in `app.json` expands to
 *     `TEAMID.`, so the value a process passes at RUNTIME is
 *     `"<TEAMID>.<group>"` — the bare group matches nothing and the item cannot
 *     be written (`errSecMissingEntitlement`) or read. `push-key.ts` and
 *     `push-directory-expo.ts` passed the bare bundle id; the extension did too.
 *  2. **An item written WITHOUT a group lands in the FIRST listed group.** So
 *     the app's own group is listed first (the Noise `deviceKey` is written with
 *     no group) and the notification items pass {@link PUSH_ACCESS_GROUP}, which
 *     is a DIFFERENT group — the extension is entitled to that one and not to
 *     the app's own, so it cannot read the key that authenticates the phone.
 *
 * The Team ID is not secret (it is in every provisioning profile) and this app
 * ships with a single team, so it is a constant: the alternative — reading it
 * from `Constants.expoConfig.ios.appleTeamId` — would be a second source of
 * truth that can disagree with the signed entitlements, which is exactly the
 * failure this file exists to prevent. `app.json`'s `ios.appleTeamId` must name
 * the same one, and `apps/mobile/test/app-config.test.ts` asserts they agree.
 */

/** The Apple Developer team that signs both the app and the extension. */
export const TEAM_ID = "8L24B2DUU2";

/** The app's OWN group: first in the entitlement, where a group-less write lands. */
export const APP_GROUP = "so.tentacle.app";

/**
 * The group the notification items share with the extension: a SEPARATE one, so
 * being entitled to it grants nothing over the app's own items (`deviceKey`).
 */
export const PUSH_GROUP = "so.tentacle.app.push";

/**
 * The access-group string a process passes at runtime: the built entitlement's
 * exact value, i.e. the team in front of the bare group. Pure, so the shape is
 * pinned without a device.
 */
export function accessGroupFor(teamId: string, group: string): string {
  return `${teamId}.${group}`;
}

/** The app's own group, as `kSecAttrAccessGroup` takes it. */
export const APP_ACCESS_GROUP = accessGroupFor(TEAM_ID, APP_GROUP);

/** The shared notification group, as `kSecAttrAccessGroup` takes it. */
export const PUSH_ACCESS_GROUP = accessGroupFor(TEAM_ID, PUSH_GROUP);
