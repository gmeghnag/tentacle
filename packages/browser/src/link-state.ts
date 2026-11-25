// linkState — the user's Chrome link as one word (docs/feat/browser-inspect.md
// B5b, `browser/status`). Pure over facts the host probed: the hub socket
// answers, the native-host manifest is ours, Chrome is running. Nothing here
// does I/O.

export type LinkState = "connected" | "not_running" | "extension_missing" | "not_installed";

export interface LinkFacts {
  /** The hub socket answered (the extension is running and linked). */
  readonly hubAnswers: boolean;
  /** The native-host manifest names our wrapper and our extension id. */
  readonly manifestOk: boolean;
  /** A Chrome process is running (undefined: not known on this platform). */
  readonly chromeRunning: boolean | undefined;
}

/**
 * A linked hub is `connected`, whatever else the probes say. Otherwise: no
 * manifest → `not_installed` (`tentacle browser install`); Chrome running but
 * no hub → `extension_missing` (the extension is off or not loaded); else
 * `not_running` (Chrome closed, or not known to be running).
 */
export function linkState(facts: LinkFacts): LinkState {
  if (facts.hubAnswers) return "connected";
  if (!facts.manifestOk) return "not_installed";
  if (facts.chromeRunning === true) return "extension_missing";
  return "not_running";
}
