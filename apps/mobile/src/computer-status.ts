/**
 * What the Computers screen says about a computer, and what its menu offers
 * (docs/feat/mobile-ui-polish.md Design 3; AGENTS §7 — the decisions live here,
 * the screen only draws them). Pure, React-free; the facts all come from
 * `ComputerRow` (`computer-rows.ts`) — no new data is invented (no "seen 2 h ago",
 * no "direct/relay": the row does not know them).
 */
import type { ComputerRow } from "./computer-rows.ts";

/** The header dot: filled green, a grey ring, or orange (needs the person). */
export type ComputerTone = "online" | "offline" | "attention";

export interface ComputerStatus {
  readonly tone: ComputerTone;
  /** The short word next to the dot ("Online", "Offline", …). */
  readonly text: string;
  /** The honest reason (`describeError`'s wording), shown under the project. */
  readonly detail?: string;
  /** A "Pair again" button on the row itself (the row cannot work without it). */
  readonly pairAgain: boolean;
}

/** One entry of the long-press / "…" menu. */
export interface MenuAction {
  readonly kind: "pair-again" | "remove";
  readonly label: string;
  readonly destructive: boolean;
}

const SHORT: Record<ComputerRow["state"], string> = {
  ok: "Online",
  unreachable: "Offline",
  revoked: "Access revoked",
  "maybe-reset": "Needs pairing again",
  broken: "Saved key damaged",
  "update-app": "Update the app",
  "update-computer": "Update tentacle",
};

/** An e2e version skew: it needs the person (attention), but an update — never a new pairing. */
const NEEDS_UPDATE: ReadonlySet<ComputerRow["state"]> = new Set(["update-app", "update-computer"]);

export function computerStatus(row: ComputerRow): ComputerStatus {
  const tone: ComputerTone =
    row.state === "ok" ? "online" : row.state === "unreachable" ? "offline" : "attention";
  return {
    tone,
    text: SHORT[row.state],
    ...(row.status === "" ? {} : { detail: row.status }),
    // Every state that needs a new pairing offers it where the person looks —
    // a `revoked` row too (its `action` is "remove" for the record, but the
    // only way back to a WORKING computer is pairing again: computer-rows.ts:12-16).
    pairAgain: tone === "attention" && !NEEDS_UPDATE.has(row.state),
  };
}

/**
 * The menu (Owner Q5): Pair again for every computer (a re-pair keeps the id,
 * Q7), then Remove — last, destructive, and confirmed by the screen.
 */
export function menuActions(_row: ComputerRow): readonly MenuAction[] {
  return [
    { kind: "pair-again", label: "Pair again", destructive: false },
    { kind: "remove", label: "Remove from this phone", destructive: true },
  ];
}

/** `482913` → `["482", "913"]` (the Pair sheet's two boxes); anything else whole. */
export function sasGroups(sas: string): readonly string[] {
  const digits = sas.replace(/\s/g, "");
  return /^\d{6}$/.test(digits) ? [digits.slice(0, 3), digits.slice(3)] : [digits];
}
