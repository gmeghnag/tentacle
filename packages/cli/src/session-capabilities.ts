/**
 * The session's MCP/skill switches on the laptop side
 * (docs/feat/session-capabilities.md S3b): carried into the session a TUI
 * creates next, the way `session-auto-accept.ts` carries auto-accept.
 */
import type { SessionCapabilities } from "@tentacle/agent";
import type { SessionCapabilitiesWire } from "@tentacle/protocol";

/**
 * Tell a controller that the NEXT session its client creates starts with its
 * switches (`OpenParams.capabilities`): a `/clear` close-and-replace keeps them
 * (owner Q5). Read structurally, like `seedAutoAcceptOf`: a controller with no
 * such seam (an in-process agent, a hop facade's member) has no daemon to seed.
 */
export function seedCapabilitiesOf(controller: unknown): void {
  const seed = (controller as { seedCapabilities?: () => void } | null)?.seedCapabilities;
  if (typeof seed === "function") seed.call(controller);
}

/** A record's switches as the wire carries them (fresh mutable arrays). */
export function wireCapabilities(state: SessionCapabilities): SessionCapabilitiesWire {
  return { disabledMcp: [...state.disabledMcp], disabledSkills: [...state.disabledSkills] };
}
