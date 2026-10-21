/**
 * `skills/list` — every skill the daemon discovered and who may invoke it,
 * plus its discovery problems (the TUI's `/skills`,
 * docs/feat/skills-panel.md). Static: a daemon's skills are fixed at start.
 * Additive (an older daemon answers `MethodNotFound`). The daemon may be a pod
 * (not trusted, AGENTS §7): every string is bounded and free of control
 * characters before anything reaches the UI.
 */
import { z } from "zod";

/** At most this many skills in one `skills/list` result. */
export const MAX_SKILL_LIST = 512;
/** At most this many discovery problems (the rest are counted in `moreProblems`). */
export const MAX_SKILL_PROBLEMS = 100;

// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
const NO_CONTROL = /^[^\u0000-\u001f\u007f-\u009f]*$/;
const line = (max: number) => z.string().min(1).max(max).regex(NO_CONTROL);

export const SkillListEntrySchema = z
  .object({
    /** As discovered: a non-spec name still loads (it just can't be a `/name`). */
    name: line(256),
    description: line(1024),
    /** `project` skills are repo-supplied; `user` ones come from the user's dirs. */
    scope: z.enum(["project", "user"]),
    /** Offered to the user as `/name`. */
    user: z.boolean(),
    /** Offered to the model (its catalog and the `skill` tool). */
    model: z.boolean(),
    /** Its `SKILL.md`, on the daemon's filesystem. */
    location: line(4096),
  })
  .strict();
export type SkillListEntry = z.infer<typeof SkillListEntrySchema>;

export const SkillsListParamsSchema = z.object({}).strict();
export type SkillsListParams = z.infer<typeof SkillsListParamsSchema>;

export const SkillsListResultSchema = z
  .object({
    /** In precedence order. */
    skills: z.array(SkillListEntrySchema).max(MAX_SKILL_LIST),
    /** Discovery problems: skipped skills, warnings, shadowing, caps. */
    problems: z.array(line(1000)).max(MAX_SKILL_PROBLEMS),
    moreProblems: z.number().int().nonnegative(),
  })
  .strict();
export type SkillsListResult = z.infer<typeof SkillsListResultSchema>;
