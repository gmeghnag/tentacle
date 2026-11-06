/**
 * `/settings` routing (docs/feat/session-settings-apply.md), pure: `/settings`
 * shows the session's settings, `/settings apply` applies this terminal's,
 * anything else is the usage. The busy check is UX: the daemon's is the truth.
 */

export const SETTINGS_USAGE = "Usage: /settings (show) · /settings apply";
/** Shown as soon as an apply is issued: during an outage it waits for the link. */
export const SETTINGS_APPLYING = "Applying this terminal's settings…";

export type SettingsCommand =
  | { readonly kind: "show" }
  | { readonly kind: "apply" }
  | { readonly kind: "notice"; readonly text: string };

export function settingsCommand(
  raw: string,
  state: {
    readonly running: boolean;
    readonly compacting: boolean;
    readonly available: boolean;
    /** An apply issued on this session has not settled. */
    readonly applying: boolean;
  },
): SettingsCommand {
  const args = raw.trim().split(/\s+/).slice(1);
  if (!state.available) {
    return { kind: "notice", text: "/settings isn't available for this session." };
  }
  if (args.length === 0) {
    return { kind: "show" };
  }
  if (args.length !== 1 || args[0] !== "apply") {
    return { kind: "notice", text: SETTINGS_USAGE };
  }
  if (state.applying) {
    return { kind: "notice", text: "Already applying this terminal's settings…" };
  }
  if (state.running) {
    return { kind: "notice", text: "Can't apply settings while a turn is running." };
  }
  if (state.compacting) {
    return { kind: "notice", text: "Can't apply settings while a compaction is running." };
  }
  return { kind: "apply" };
}
