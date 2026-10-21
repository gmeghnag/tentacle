/**
 * What the `/skills` panel says (docs/feat/skills-panel.md): one group per
 * skill the daemon discovered — name, who may invoke it and its description
 * as the head; (expanded) the full description, how it is invoked and where
 * it lives — then one group for the discovery problems. The panel mechanics
 * live in `tree-panel.ts`.
 *
 * Every daemon string passes through `oneLine` (bidi/zero-width dropped): the
 * schema only rejects control characters, and the daemon may be a pod.
 */
import { oneLine } from "./commands.ts";
import { type TreeGroup, wrapText } from "./tree-panel.ts";

/** One skill as `skills/list` reports it. */
export interface SkillView {
  readonly name: string;
  readonly description: string;
  readonly scope: "project" | "user";
  /** Offered to the user as `/name`. */
  readonly user: boolean;
  /** Offered to the model. */
  readonly model: boolean;
  readonly location: string;
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

function who(s: SkillView): string {
  if (s.user && s.model) {
    return "you + model";
  }
  if (s.user) {
    return "you only";
  }
  return s.model ? "model only" : "hidden";
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

const problemCount = (list: SkillsListView): number => list.problems.length + list.moreProblems;

/** The groups at `width` columns (the description wraps to it). */
export function skillGroups(list: SkillsListView, width: number): TreeGroup[] {
  const nameWidth = Math.min(
    NAME_COLUMN_MAX,
    list.skills.reduce((w, s) => Math.max(w, oneLine(s.name).length), 0),
  );
  const groups: TreeGroup[] = list.skills.map((s) => {
    const name = oneLine(s.name);
    const description = oneLine(s.description);
    return {
      head: `${name.padEnd(nameWidth)}  ${who(s).padEnd(11)}  ${description}`,
      children: [
        ...wrapText(description, width - CHILD_PREFIX, DESCRIPTION_LINES),
        `${s.user ? `/${name}` : "no /command"} · ${s.model ? "offered to the model" : "not offered to the model"}`,
        `${s.scope} · ${oneLine(s.location)}`,
      ],
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

export function skillsTitle(list: SkillsListView): string {
  const problems = problemCount(list);
  return `Skills · ${list.skills.length} found${problems > 0 ? ` · ${plural(problems, "problem")}` : ""}`;
}

/** Nothing to show: no skill and no problem. */
export const skillsEmpty = (list: SkillsListView): boolean =>
  list.skills.length === 0 && problemCount(list) === 0;
