/**
 * What the `/tools` panel says (docs/feat/tool-toggles.md D7): the session's
 * registered built-in tools, one group per switch group (expandable to its
 * members, like `/mcp` servers) plus the ungrouped tools, each with the
 * heuristic token cost of its definition (`~N`). The switch decisions live in
 * `capability-toggles.ts`; the panel mechanics in `tree-panel.ts`. React-free
 * and pure (AGENTS §7).
 *
 * The daemon is the truth: a row's switch is the state the daemon last
 * REPORTED (`capabilities`), never the list's own `disabled` (read once, at
 * open) — except before the session is open, where the list's flags are all
 * there is (the session a create would build now). Every daemon string passes
 * through `oneLine`: the daemon may be a pod.
 */
import {
  type CapOp,
  type CapsPhase,
  groupSwitch,
  isOff,
  switchGlyph,
  switchOp,
  toolSwitch,
  toolsPhase,
} from "./capability-toggles.ts";
import { oneLine } from "./commands.ts";
import type { TreeGroup } from "./tree-panel.ts";

/** One registered built-in as `session/tools` reports it. */
export interface ToolEntryView {
  readonly name: string;
  readonly group?: string;
  readonly tokens: number;
  readonly disabled?: true;
  readonly locked?: true;
}

/** One panel group: a switch group (with its members) or a single ungrouped tool. */
export type ToolsItem =
  | { readonly kind: "group"; readonly name: string; readonly members: readonly ToolEntryView[] }
  | { readonly kind: "tool"; readonly tool: ToolEntryView };

/** Names are padded to align the token column, up to this width. */
const NAME_COLUMN_MAX = 18;

/**
 * The panel's items, in the daemon's order: a group appears where its first
 * member does; a tool with no group is an item of its own.
 */
export function toolsItems(tools: readonly ToolEntryView[]): ToolsItem[] {
  const items: ToolsItem[] = [];
  const groups = new Map<string, ToolEntryView[]>();
  for (const t of tools) {
    if (t.group === undefined) {
      items.push({ kind: "tool", tool: t });
      continue;
    }
    const members = groups.get(t.group);
    if (members) {
      members.push(t);
    } else {
      const fresh = [t];
      groups.set(t.group, fresh);
      items.push({ kind: "group", name: t.group, members: fresh });
    }
  }
  return items;
}

/** Off for the model now: the daemon's report when it has one, else the list's flag. */
function toolOff(phase: CapsPhase, t: ToolEntryView): boolean {
  const p = toolsPhase(phase);
  return p.kind === "on" ? t.locked !== true && isOff(p.caps, "tool", t.name) : t.disabled === true;
}

const tokens = (n: number): string => `~${n}`;
const sum = (ts: readonly ToolEntryView[]): number => ts.reduce((n, t) => n + t.tokens, 0);

function itemSwitch(phase: CapsPhase, item: ToolsItem) {
  return item.kind === "group"
    ? groupSwitch(
        phase,
        item.members.map((m) => m.name),
      )
    : toolSwitch(phase, item.tool);
}

const lead = (sw: ReturnType<typeof toolSwitch>): string =>
  sw === null ? "" : `${switchGlyph(sw)} `;

/** `phase`: the session's switches (the panel applies `toolsPhase` itself). */
export function toolsGroups(tools: readonly ToolEntryView[], phase: CapsPhase): TreeGroup[] {
  const items = toolsItems(tools);
  const width = Math.min(
    NAME_COLUMN_MAX,
    items.reduce(
      (w, item) => Math.max(w, oneLine(item.kind === "group" ? item.name : item.tool.name).length),
      0,
    ),
  );
  return items.map((item) => {
    if (item.kind === "tool") {
      const t = item.tool;
      const note = t.locked === true ? "  always on" : "";
      return {
        head: `${lead(toolSwitch(phase, t))}${oneLine(t.name).padEnd(width)}  ${tokens(t.tokens)}${note}`,
        children: [],
        ...(toolOff(phase, t) ? { off: true } : {}),
      };
    }
    const count = item.members.length;
    return {
      head: `${lead(itemSwitch(phase, item))}${oneLine(item.name).padEnd(width)}  ${tokens(
        sum(item.members),
      )}  ${count} tool${count === 1 ? "" : "s"}`,
      children: item.members.map(
        (m) => `${lead(toolSwitch(phase, m))}${oneLine(m.name)}  ${tokens(m.tokens)}`,
      ),
      ...(item.members.every((m) => toolOff(phase, m)) ? { off: true } : {}),
    };
  });
}

/** The title: the cost of what the model is offered now, how many are off, what a switch does. */
export function toolsTitle(tools: readonly ToolEntryView[], phase: CapsPhase): string {
  const off = tools.filter((t) => toolOff(phase, t));
  const offered = sum(tools) - sum(off);
  const p = toolsPhase(phase);
  const note =
    p.kind === "on"
      ? "this session · applies to the next model call"
      : p.kind === "not-open"
        ? "on/off after the first message"
        : "on/off needs a newer tentacle on this computer";
  return `Tools · ~${offered} tokens · ${off.length} off · ${note}`;
}

/**
 * What Space on the row at (`group`, `child`) asks: a group head → the group
 * (one op, atomic daemon-side), a member or an ungrouped tool → that tool;
 * null when the row has no switch (`skill`, no switch shown).
 */
export function toolsSwitchOp(
  tools: readonly ToolEntryView[],
  phase: CapsPhase,
  group: number,
  child: number | null,
): CapOp | null {
  const item = toolsItems(tools)[group];
  if (item === undefined) {
    return null;
  }
  if (item.kind === "tool") {
    return switchOp("tool", item.tool.name, toolSwitch(phase, item.tool));
  }
  if (child === null) {
    const op = switchOp("tool", item.name, itemSwitch(phase, item));
    return op === null ? null : { ...op, members: item.members.map((m) => m.name) };
  }
  const member = item.members[child];
  return member === undefined ? null : switchOp("tool", member.name, toolSwitch(phase, member));
}

/** What Space says when `/tools` shows no switch (null: nothing to say). */
export function toolsNoSwitchNotice(phase: CapsPhase): string | null {
  switch (toolsPhase(phase).kind) {
    case "not-open":
      return "_On/off applies to a started session: send a first message, then try again._";
    case "unsupported":
      return "_Tool on/off needs a newer tentacle on this computer._";
    default:
      return null;
  }
}
