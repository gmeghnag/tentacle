/**
 * The session's MCP/skill/built-in-tool switches in the TUI
 * (docs/feat/session-capabilities.md S4, docs/feat/tool-toggles.md D7): what
 * each `/mcp`, `/skills` and `/tools` row's switch says, what Space asks the
 * daemon, the status-line marker, and which reported change earns a transcript
 * notice. React-free and pure (AGENTS §7): `App` holds the state and executes,
 * the panels render the glyphs, every decision is tested here.
 *
 * The daemon is the truth: a row shows the state the daemon last REPORTED (its
 * snapshot on open, then every `capabilities` echo), never an optimistic copy.
 * Names and the `by` label are daemon strings (a pod may send them): every one
 * shown passes through `oneLine`.
 */
import { oneLine } from "./commands.ts";

/** The session's switches (structurally `SessionCapabilitiesWire`): disabled names. */
export interface CapsView {
  readonly disabledMcp: readonly string[];
  readonly disabledSkills: readonly string[];
  /**
   * Built-in tools switched off (docs/feat/tool-toggles.md). ABSENT: the daemon
   * has no tool switches (an older one) — `/tools` shows no switch.
   */
  readonly disabledTools?: readonly string[];
}

export type CapKind = "mcp" | "skill" | "tool";

/** One request: turn `name` on (`enabled`) or off for the model. */
export interface CapOp {
  readonly kind: CapKind;
  readonly name: string;
  readonly enabled: boolean;
  /**
   * A `/tools` GROUP op: its registered members (from the panel's list). The
   * daemon echoes one change per member; this matches that echo to the op.
   */
  readonly members?: readonly string[];
}

/**
 * What the panels can do with the switches now:
 * - `on`: the daemon reported them — one switch per row;
 * - `not-open`: no session daemon-side yet (a fresh or resumed session opens at
 *   its first message), so there is nothing to switch on the daemon yet;
 * - `unsupported`: the daemon (or this runtime) has none — an older daemon, or
 *   one that answered `MethodNotFound` (F7). No switch is shown.
 */
export type CapsPhase =
  | { readonly kind: "on"; readonly caps: CapsView }
  | { readonly kind: "not-open" }
  | { readonly kind: "unsupported" };

/**
 * `caps`: the daemon's last report (undefined: none). `opened`: the session is
 * open daemon-side. `settable`: the controller can send a switch at all.
 */
export function capsPhase(
  caps: CapsView | undefined,
  opened: boolean,
  settable: boolean,
): CapsPhase {
  if (!settable) {
    return { kind: "unsupported" };
  }
  if (caps !== undefined) {
    return { kind: "on", caps };
  }
  return opened ? { kind: "unsupported" } : { kind: "not-open" };
}

/**
 * The phase of a session controller (structurally `SessionController`'s three
 * members): with no `opened`, a session is taken as open — no switches then
 * means the daemon has none.
 */
export function sessionCapsPhase(
  session: {
    readonly setCapability?: unknown;
    opened?(): boolean;
  } | null,
  caps: CapsView | undefined,
): CapsPhase {
  return capsPhase(caps, session?.opened?.() ?? true, typeof session?.setCapability === "function");
}

const setOf = (caps: CapsView, kind: CapKind): readonly string[] =>
  kind === "mcp"
    ? caps.disabledMcp
    : kind === "skill"
      ? caps.disabledSkills
      : (caps.disabledTools ?? []);

export const isOff = (caps: CapsView, kind: CapKind, name: string): boolean =>
  setOf(caps, kind).includes(name);

/**
 * A row's switch: visible to the model, off for this session, never the
 * model's choice (`locked`), or — a `/tools` group only — some members off
 * (`partial`).
 */
export type SwitchState = "on" | "off" | "locked" | "partial";

const GLYPHS: Readonly<Record<SwitchState, string>> = {
  on: "[✓]",
  off: "[ ]",
  locked: "[–]",
  partial: "[~]",
};

export const switchGlyph = (state: SwitchState): string => GLYPHS[state];

/**
 * The model can never invoke this skill — its SKILL.md sets
 * `disable-model-invocation` — so it is not this session's choice: the model is
 * not offered it now, nor at the next context reset (`session-skills.ts`).
 */
export const skillLocked = (s: {
  readonly model: boolean;
  readonly modelAfterReset?: boolean;
}): boolean => !s.model && s.modelAfterReset !== true;

/** A server row's switch, or null when the phase shows none. */
export function mcpSwitch(phase: CapsPhase, name: string): SwitchState | null {
  if (phase.kind !== "on") {
    return null;
  }
  return isOff(phase.caps, "mcp", name) ? "off" : "on";
}

/** A skill row's switch, or null when the phase shows none. */
export function skillSwitch(
  phase: CapsPhase,
  s: { readonly name: string; readonly model: boolean; readonly modelAfterReset?: boolean },
): SwitchState | null {
  if (phase.kind !== "on") {
    return null;
  }
  if (skillLocked(s)) {
    return "locked";
  }
  return isOff(phase.caps, "skill", s.name) ? "off" : "on";
}

/**
 * The phase `/tools` shows: the session's, except a daemon that reported
 * switches WITHOUT `disabledTools` has no tool switches (an older one, F8).
 */
export function toolsPhase(phase: CapsPhase): CapsPhase {
  return phase.kind === "on" && phase.caps.disabledTools === undefined
    ? { kind: "unsupported" }
    : phase;
}

/** A built-in tool row's switch (`skill` is `locked`), or null when the phase shows none. */
export function toolSwitch(
  phase: CapsPhase,
  t: { readonly name: string; readonly locked?: boolean },
): SwitchState | null {
  const p = toolsPhase(phase);
  if (p.kind !== "on") {
    return null;
  }
  if (t.locked === true) {
    return "locked";
  }
  return isOff(p.caps, "tool", t.name) ? "off" : "on";
}

/**
 * A `/tools` group row's switch from its REGISTERED members: all on, all off,
 * or `partial`; null when the phase shows none (or the group has no member).
 */
export function groupSwitch(phase: CapsPhase, members: readonly string[]): SwitchState | null {
  const p = toolsPhase(phase);
  if (p.kind !== "on" || members.length === 0) {
    return null;
  }
  const off = members.filter((m) => isOff(p.caps, "tool", m)).length;
  return off === 0 ? "on" : off === members.length ? "off" : "partial";
}

/** What the title rule adds after the panel's own title. */
export function capsTitleNote(phase: CapsPhase): string {
  switch (phase.kind) {
    case "on":
      return "this session · applies to the next model call";
    case "not-open":
      return "on/off after the first message";
    default:
      return "on/off not supported by this computer";
  }
}

/** The key hint when the rows carry a switch. */
export const CAPS_HINT = "space on/off · ↑↓ select · enter expand · esc close";

/**
 * What Space on a row asks: the op that flips its switch, or null when the row
 * has nothing to flip (a locked skill, the problems group, no switch shown).
 */
export function switchOp(kind: CapKind, name: string, state: SwitchState | null): CapOp | null {
  if (state === null || state === "locked") {
    return null;
  }
  // A partially-off group turns ON (docs/feat/tool-toggles.md Q7): the safe,
  // reversible reading; a second Space turns it all off.
  return { kind, name, enabled: state === "off" || state === "partial" };
}

/** What Space says when the phase shows no switch (null: nothing to say). */
export function noSwitchNotice(phase: CapsPhase): string | null {
  switch (phase.kind) {
    case "not-open":
      return "_On/off applies to a started session: send a first message, then try again._";
    case "unsupported":
      return "_MCP/skill on/off is not supported by this computer._";
    default:
      return null;
  }
}

/** A set the daemon refused (or a dropped link). */
export const switchFailedNotice = (op: CapOp, error: unknown): string =>
  `_Could not turn ${oneLine(op.name)} ${op.enabled ? "on" : "off"}: ${oneLine(
    error instanceof Error ? error.message : String(error),
  )}_`;

/** The status-line marker while something is off (null when everything is on). */
export function capsMarker(caps: CapsView | undefined): string | null {
  if (caps === undefined) {
    return null;
  }
  const parts: string[] = [];
  const servers = caps.disabledMcp.length;
  const skills = caps.disabledSkills.length;
  const tools = caps.disabledTools?.length ?? 0;
  if (servers > 0) {
    parts.push(`${servers} server${servers === 1 ? "" : "s"}`);
  }
  if (skills > 0) {
    parts.push(`${skills} skill${skills === 1 ? "" : "s"}`);
  }
  if (tools > 0) {
    parts.push(`${tools} tool${tools === 1 ? "" : "s"}`);
  }
  return parts.length === 0 ? null : `⊘ ${parts.join(" · ")} off`;
}

/** The ops that turn `prev` into `next` (an item absent from `prev`'s set was on). */
export function capsDiff(prev: CapsView | undefined, next: CapsView): CapOp[] {
  const before = prev ?? { disabledMcp: [], disabledSkills: [] };
  const ops: CapOp[] = [];
  const diff = (kind: CapKind, was: readonly string[], now: readonly string[]): void => {
    for (const name of now) {
      if (!was.includes(name)) ops.push({ kind, name, enabled: false });
    }
    for (const name of was) {
      if (!now.includes(name)) ops.push({ kind, name, enabled: true });
    }
  };
  diff("mcp", before.disabledMcp, next.disabledMcp);
  diff("skill", before.disabledSkills, next.disabledSkills);
  diff("tool", before.disabledTools ?? [], next.disabledTools ?? []);
  return ops;
}

const sameOp = (a: CapOp, b: CapOp): boolean =>
  a.kind === b.kind && a.name === b.name && a.enabled === b.enabled;

/**
 * Which part of a reported change is news (owner Q4): a change another DEVICE
 * made. `by` is set only on a change (a snapshot is never news: an attach
 * adopts a state, nobody pressed anything). A changed item matching one of
 * this TUI's own sets still awaiting its answer (`pending`) is that set's echo
 * and says nothing — the row already flipped in front of the person.
 */
export function remoteChangeNotices(
  prev: CapsView | undefined,
  next: CapsView | undefined,
  by: string | undefined,
  pending: readonly CapOp[],
): string[] {
  if (next === undefined || by === undefined) {
    return [];
  }
  // A `/tools` group set is ONE op that echoes as one change per member: its
  // own echo is matched member by member.
  const own: CapOp[] = pending.flatMap((p) =>
    p.members === undefined
      ? [p]
      : p.members.map((name) => ({ kind: p.kind, name, enabled: p.enabled })),
  );
  const notices: string[] = [];
  for (const op of capsDiff(prev, next)) {
    const i = own.findIndex((p) => sameOp(p, op));
    if (i >= 0) {
      own.splice(i, 1);
      continue;
    }
    const what = op.kind === "mcp" ? "MCP server" : op.kind === "skill" ? "skill" : "tool";
    notices.push(
      `${what} ${oneLine(op.name)} turned ${op.enabled ? "on" : "off"} on ${oneLine(by) || "another device"} · applies to the next model call`,
    );
  }
  return notices;
}

/** `pending` without one entry equal to `op` (its answer arrived). */
export function settled(pending: readonly CapOp[], op: CapOp): CapOp[] {
  const i = pending.findIndex((p) => sameOp(p, op));
  return i < 0 ? [...pending] : [...pending.slice(0, i), ...pending.slice(i + 1)];
}
