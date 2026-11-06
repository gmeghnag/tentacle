/**
 * `/settings` routing (docs/feat/session-settings-apply.md), pure: `/settings`
 * shows the session's settings, `/settings sync` makes it use this terminal's,
 * anything else is the usage. The busy check is UX: the daemon's is the truth.
 */

export const SETTINGS_USAGE = "Usage: /settings (show) · /settings sync";
/** Shown as soon as a sync is issued: during an outage it waits for the link. */
export const SETTINGS_SYNCING = "Syncing this terminal's settings…";

export type SettingsCommand =
  | { readonly kind: "show" }
  | { readonly kind: "sync" }
  | { readonly kind: "notice"; readonly text: string };

export function settingsCommand(
  raw: string,
  state: {
    readonly running: boolean;
    readonly compacting: boolean;
    readonly available: boolean;
    /** A sync issued on this session has not settled. */
    readonly syncing: boolean;
  },
): SettingsCommand {
  const args = raw.trim().split(/\s+/).slice(1);
  if (!state.available) {
    return { kind: "notice", text: "/settings isn't available for this session." };
  }
  if (args.length === 0) {
    return { kind: "show" };
  }
  if (args.length !== 1 || args[0] !== "sync") {
    return { kind: "notice", text: SETTINGS_USAGE };
  }
  if (state.syncing) {
    return { kind: "notice", text: "Already syncing this terminal's settings…" };
  }
  if (state.running) {
    return { kind: "notice", text: "Can't sync settings while a turn is running." };
  }
  if (state.compacting) {
    return { kind: "notice", text: "Can't sync settings while a compaction is running." };
  }
  return { kind: "sync" };
}
