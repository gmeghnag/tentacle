/**
 * The status bar's target badge, from facts the LAPTOP holds (docs/feat/tui-target-badge.md):
 * the engine host's kind, the workload name this laptop created or the user
 * typed, and — k8s — the container in use (always shown, also for a one-container pod).
 * Pure. Nothing here comes from the pod; the strings are sanitised anyway
 * (an `attach <name>` argument is user text, but cheap to make safe).
 */
import type { TargetBadge } from "@tentacle/tui";
import type { EngineHost } from "./engine-host.ts";
import { untrustedText } from "./untrusted-text.ts";

export function engineTarget(
  host: Pick<EngineHost, "kind">,
  name: string,
  container?: string,
): TargetBadge {
  const shown = untrustedText(name);
  if (host.kind === "kubernetes" && container !== undefined) {
    return { engine: "kubernetes", name: shown, container: untrustedText(container) };
  }
  return { engine: host.kind, name: shown };
}
