/**
 * The switches a person flips BEFORE the session is open daemon-side
 * (docs/feat/caps-before-first-message.md D1): a fresh, `--resume`d or
 * `/clear`ed session is created lazily by its first message, so `/mcp`,
 * `/skills` and `/tools` have no daemon state to switch yet. The client records
 * the flips here, shows them as a PREVIEW, and applies them inside the one open
 * (`session/open` → one `session/set_capability` per flip, each awaited →
 * `session/prompt`), so the first model call already runs with them.
 *
 * Pure: no React, no I/O, no client — the state and the execution live in
 * `RemoteSession`. The preview reuses the daemon's own `applyCapabilityOp` (in
 * `@tentacle/core`, so the phone can bundle it — docs/fix/mobile-bundle-node-import.md),
 * so what the person sees and what the daemon will do come from ONE set of rules.
 */
import {
  type CapabilityOp,
  CapabilityRefusal,
  type SessionCapabilities,
  applyCapabilityOp,
} from "@tentacle/core";
import type { SessionCapabilitiesWire } from "@tentacle/protocol";

/** One switch pressed before the open: a delta, like the wire's `set_capability`. */
export interface CapabilityFlip {
  readonly kind: "mcp" | "skill" | "tool";
  readonly name: string;
  readonly enabled: boolean;
}

const sameKey = (a: CapabilityFlip, b: CapabilityFlip): boolean =>
  a.kind === b.kind && a.name === b.name;

/** One flip's identity: a `/tools` group and its member are different keys. */
export const flipKey = (flip: CapabilityFlip): string => `${flip.kind}\u0000${flip.name}`;

/**
 * Last wins per (kind, name): an earlier flip of the same key is removed and the
 * new one goes LAST. The final state is what the person's whole press sequence
 * would give — every flip assigns `enabled` to the names it covers (a `/tools`
 * group covers its members), so a superseded one can only be overwritten — and
 * the order between DIFFERENT keys is kept, which a group and its member need:
 * `visuals` off then `chart` on leaves `chart` on, `diagram` and `present` off;
 * the reverse order leaves all three off.
 */
export function noteFlip(
  pending: readonly CapabilityFlip[],
  flip: CapabilityFlip,
): CapabilityFlip[] {
  return [...pending.filter((p) => !sameKey(p, flip)), flip];
}

const asState = (caps: SessionCapabilitiesWire): SessionCapabilities => ({
  disabledMcp: caps.disabledMcp,
  disabledSkills: caps.disabledSkills,
  disabledTools: caps.disabledTools ?? [],
});

/**
 * The text the daemon would give for a flip the agent's table refuses (F8: an
 * unknown built-in tool or group, or `skill`, which is always on). The panel is
 * the belt (it shows `skill` locked), this is the brace.
 */
export const flipRefusal = (flip: CapabilityFlip): string =>
  new CapabilityRefusal({ kind: flip.kind, name: flip.name, enabled: flip.enabled }).message;

const asWire = (state: SessionCapabilities): SessionCapabilitiesWire => ({
  disabledMcp: [...state.disabledMcp],
  disabledSkills: [...state.disabledSkills],
  disabledTools: [...state.disabledTools],
});

/**
 * What the switches WILL be once the open's sets land: `base` (the create seed
 * the open sends) with `pending` applied IN ORDER through the agent's own
 * `applyCapabilityOp`, so a `/tools` group expands exactly as the daemon will
 * expand it. A flip the agent's table refuses (an unknown tool or group, or
 * `skill`, which is always on) is returned in `refused`, never applied.
 */
export function previewCapabilities(
  base: SessionCapabilitiesWire,
  pending: readonly CapabilityFlip[],
): { readonly caps: SessionCapabilitiesWire; readonly refused: readonly CapabilityFlip[] } {
  let state = asState(base);
  const refused: CapabilityFlip[] = [];
  for (const flip of pending) {
    const op: CapabilityOp = { kind: flip.kind, name: flip.name, enabled: flip.enabled };
    try {
      state = applyCapabilityOp(state, op);
    } catch {
      refused.push(flip);
    }
  }
  return { caps: asWire(state), refused };
}

/**
 * The base the preview starts from — what `openSession` will SEED: the one-shot
 * seed `capabilities ?? carried` with the laptop's own tool switches unioned in
 * (`withBaseTools`, off wins), plus the host's own `session/tools` `disabled`
 * names (a pod's `tools.enabled`, unknown until `/tools` was opened once).
 * Sorted and de-duplicated, like the agent's state.
 */
export function previewBase(
  seed: SessionCapabilitiesWire | undefined,
  hostDisabledTools: readonly string[],
): SessionCapabilitiesWire {
  const tools = new Set([...(seed?.disabledTools ?? []), ...hostDisabledTools]);
  return {
    disabledMcp: [...(seed?.disabledMcp ?? [])],
    disabledSkills: [...(seed?.disabledSkills ?? [])],
    disabledTools: [...tools].sort(),
  };
}

/**
 * The skill flips whose name the OPENED session does not list (D4/Q3): an
 * unknown skill name is STORED by the daemon, not refused, so the only honest
 * line is one the post-set `session/skills` read can prove. The switch stays
 * (it applies again if the skill comes back); the prompt is not held — an
 * absent skill is invisible to the model either way.
 */
export function vanishedSkills(
  flips: readonly CapabilityFlip[],
  sessionSkillNames: readonly string[],
): CapabilityFlip[] {
  const present = new Set(sessionSkillNames);
  return flips.filter((flip) => flip.kind === "skill" && !present.has(flip.name));
}

/** One switch the open could not apply, with the daemon's own reason. */
export interface SwitchFailure {
  readonly kind: "mcp" | "skill" | "tool";
  readonly name: string;
  readonly enabled: boolean;
  readonly reason: string;
}

/**
 * A first message held back because a switch flipped before it could not be
 * applied (F2): the session IS open (the panels now show its real state), and
 * NOTHING was sent to the model — sending anyway would run the first call "as
 * if applied", which is exactly what the person ruled out.
 *
 * Local only: it never goes on the wire, so it is not a protocol error code.
 * The TUI recognises it structurally, by `name` (it does not depend on
 * `@tentacle/client`).
 */
export class SwitchesNotAppliedError extends Error {
  readonly failed: readonly SwitchFailure[];

  constructor(failed: readonly SwitchFailure[]) {
    super(
      `a switch could not be applied: ${failed
        .map((f) => `${f.name} ${f.enabled ? "on" : "off"} (${f.reason})`)
        .join(", ")}`,
    );
    this.name = "SwitchesNotAppliedError";
    this.failed = failed;
  }
}
