/**
 * What the `/skills` panel says (docs/feat/skills-panel.md): one group per
 * skill the daemon discovered — its switch, name and description as the head
 * (the quiet grammar, docs/feat/session-capabilities.md S4); (expanded) the
 * full description, who may invoke it and why, and where it lives — then one
 * group for the discovery problems. The panel mechanics
 * live in `tree-panel.ts`.
 *
 * Every daemon string passes through `oneLine` (bidi/zero-width dropped): the
 * schema only rejects control characters, and the daemon may be a pod.
 */
import {
  type CapsPhase,
  capsTitleNote,
  skillLocked,
  skillSwitch,
  switchGlyph,
} from "./capability-toggles.ts";
import { oneLine } from "./commands.ts";
import { type TreeGroup, wrapText } from "./tree-panel.ts";

/** One skill as `session/skills` reports it. */
export interface SkillView {
  readonly name: string;
  readonly description: string;
  readonly scope: "project" | "user";
  /** Offered to the user as `/name`. */
  readonly user: boolean;
  /** Offered to the model in this session now. */
  readonly model: boolean;
  /** Not offered to the model yet: it is at the session's next context reset. */
  readonly modelAfterReset?: boolean;
  readonly location: string;
}

/**
 * Who can invoke it, and why (the expanded row; the head carries only the
 * switch — docs/feat/session-capabilities.md S4, the quiet grammar). `off`:
 * turned off for the model in this session.
 */
function modelNote(s: SkillView, off: boolean): string {
  if (skillLocked(s)) {
    return s.user
      ? "only you: its SKILL.md sets disable-model-invocation"
      : "not offered to the model";
  }
  if (off) {
    return s.user
      ? "off for the model in this session — you can still run it"
      : "off for the model in this session";
  }
  if (!s.model) {
    return "model: after a context reset";
  }
  return s.user ? "the model sees it too" : "the model sees it";
}

export interface SkillsListView {
  readonly skills: readonly SkillView[];
  readonly problems: readonly string[];
  readonly moreProblems: number;
}

/** Skill names are padded to align the next column, up to this width. */
const NAME_COLUMN_MAX = 24;
/** At most this many lines of a skill's description when expanded. */
const DESCRIPTION_LINES = 8;
/** Columns a child row loses to the marker and the indent (`tree-panel.ts`). */
const CHILD_PREFIX = 8;

/** No switch column: the phase shows none (`capsPhase`). */
const NO_CAPS: CapsPhase = { kind: "unsupported" };

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const problemCount = (list: SkillsListView): number => list.problems.length + list.moreProblems;

/**
 * The groups at `width` columns (the description wraps to it). `phase`: the
 * session's switches (`capability-toggles.ts`); none by default. Skill `i` is
 * group `i`; the problems group, when any, comes last.
 */
export function skillGroups(
  list: SkillsListView,
  width: number,
  phase: CapsPhase = NO_CAPS,
): TreeGroup[] {
  const nameWidth = Math.min(
    NAME_COLUMN_MAX,
    list.skills.reduce((w, s) => Math.max(w, oneLine(s.name).length), 0),
  );
  const groups: TreeGroup[] = list.skills.map((s) => {
    const name = oneLine(s.name);
    const description = oneLine(s.description);
    const sw = skillSwitch(phase, s);
    const lead = sw === null ? "" : `${switchGlyph(sw)} `;
    const off = sw === "off";
    return {
      head: `${lead}${name.padEnd(nameWidth)}  ${description}`,
      children: [
        ...wrapText(description, width - CHILD_PREFIX, DESCRIPTION_LINES),
        `${s.user ? `/${name}` : "no /command"} · ${modelNote(s, off)}`,
        `${s.scope} · ${oneLine(s.location)}`,
      ],
      ...(off || sw === "locked" ? { off: true } : {}),
    };
  });
  const problems = problemCount(list);
  if (problems > 0) {
    groups.push({
      head: `! ${plural(problems, "discovery problem")}`,
      children: [
        ...list.problems.map(oneLine),
        ...(list.moreProblems > 0 ? [`… ${list.moreProblems} more`] : []),
      ],
    });
  }
  return groups;
}

/** `phase` given: the title also says what the switches do now. */
export function skillsTitle(list: SkillsListView, phase?: CapsPhase): string {
  const problems = problemCount(list);
  const base = `Skills · ${list.skills.length} found${problems > 0 ? ` · ${plural(problems, "problem")}` : ""}`;
  return phase === undefined ? base : `${base} · ${capsTitleNote(phase)}`;
}

/** Nothing to show: no skill and no problem. */
export const skillsEmpty = (list: SkillsListView): boolean =>
  list.skills.length === 0 && problemCount(list) === 0;
