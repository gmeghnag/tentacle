/**
 * The pure core of the per-session capability switches
 * (docs/feat/session-capabilities.md): the state, the op and its one rule,
 * `applyCapabilityOp`. It lives in core — no I/O, no Node — because the client's
 * pre-open preview (`@tentacle/client` `pending-capabilities.ts`, bundled into
 * the phone app) applies the SAME rule the daemon does
 * (docs/fix/mobile-bundle-node-import.md). `@tentacle/agent`'s
 * `capabilities.ts` re-exports it and adds the projections the model sees.
 */
import { ALWAYS_ON_TOOLS, expandToolName } from "./tool-groups.ts";

/** A session's capability switches: sorted, de-duplicated names, the three disabled sets. */
export interface SessionCapabilities {
  readonly disabledMcp: readonly string[];
  readonly disabledSkills: readonly string[];
  /** Built-in tools switched off (docs/feat/tool-toggles.md), groups expanded. */
  readonly disabledTools: readonly string[];
}

/** Everything on: a brand-new session's state. */
export const NO_CAPABILITIES: SessionCapabilities = {
  disabledMcp: [],
  disabledSkills: [],
  disabledTools: [],
};

/** The kinds a switch can turn off. */
export type CapabilityKind = "mcp" | "skill" | "tool";

/**
 * One toggle, as the protocol carries it: a DELTA (not the whole state), so two
 * clients toggling different items both land.
 */
export interface CapabilityOp {
  readonly kind: CapabilityKind;
  readonly name: string;
  readonly enabled: boolean;
}

const KEY_OF = {
  mcp: "disabledMcp",
  skill: "disabledSkills",
  tool: "disabledTools",
} as const satisfies Record<CapabilityKind, keyof SessionCapabilities>;

/**
 * Why a `tool` op cannot apply: its name is no built-in tool or group, or it
 * names an always-on tool (`skill`). Built-in names are static per build, so
 * an unknown one is a typo or version skew — never stored (unlike MCP/skill
 * names, which may appear later).
 */
export class CapabilityRefusal extends Error {
  constructor(readonly op: CapabilityOp) {
    super(
      ALWAYS_ON_TOOLS.includes(op.name)
        ? `${op.name} is always on and cannot be switched`
        : `unknown built-in tool or group: ${JSON.stringify(op.name)}`,
    );
    this.name = "CapabilityRefusal";
  }
}

/**
 * The state after `op`. Idempotent: when nothing changes, the SAME object comes
 * back, so a caller can tell "no change" from "changed" by identity (and a
 * no-op set emits no session-log entry and no broadcast). A `tool` op names a
 * tool OR a group: a group is ONE op (atomic, one log entry, one broadcast).
 * An unknown tool name or `skill` throws a `CapabilityRefusal`, state untouched.
 */
export function applyCapabilityOp(
  state: SessionCapabilities,
  op: CapabilityOp,
): SessionCapabilities {
  const names = op.kind === "tool" ? expandToolName(op.name) : [op.name];
  if (names === undefined) {
    throw new CapabilityRefusal(op);
  }
  const key = KEY_OF[op.kind];
  const current = state[key];
  if (!names.some((name) => current.includes(name) !== !op.enabled)) {
    return state;
  }
  const next = new Set(current);
  for (const name of names) {
    if (op.enabled) {
      next.delete(name);
    } else {
      next.add(name);
    }
  }
  return { ...state, [key]: [...next].sort() };
}
