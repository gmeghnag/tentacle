/**
 * `session/skills` — the skills of ONE session, read again from disk
 * (docs/feat/skills-hot-reload.md): the `/name` list (`slash`), every skill
 * found and who may invoke it, plus the discovery problems (the TUI's `/`
 * popup and `/skills`, docs/feat/skills-panel.md). A request, so the client
 * knows when its list is fresh; the daemon never pushes. The daemon may be a
 * pod (not trusted, AGENTS §7): every string is bounded and free of control
 * characters before anything reaches the UI.
 */
import { z } from "zod";
import { MAX_SKILL_CATALOG, SessionIdSchema, SkillSummarySchema } from "./session.ts";
import { line } from "./text-line.ts";

/** At most this many skills in one `session/skills` result. */
export const MAX_SKILL_LIST = 512;
/** At most this many discovery problems (the rest are counted in `moreProblems`). */
export const MAX_SKILL_PROBLEMS = 100;

export const SkillListEntrySchema = z.object({
  /** As discovered: a non-spec name still loads (it just can't be a `/name`). */
  name: line(256),
  description: line(1024),
  /** `project` skills are repo-supplied; `user` ones come from the user's dirs. */
  scope: z.enum(["project", "user"]),
  /** Offered to the user as `/name`. */
  user: z.boolean(),
  /** Offered to the model in this session now (its catalog and the `skill` tool). */
  model: z.boolean(),
  /**
   * Not offered to the model now, but the disk offers it: the model gets it
   * at the session's next context reset (the model's set changes only there).
   */
  modelAfterReset: z.boolean().optional(),
  /** Its `SKILL.md`, on the daemon's filesystem. */
  location: line(4096),
});
export type SkillListEntry = z.infer<typeof SkillListEntrySchema>;

export const SessionSkillsParamsSchema = z.object({
  /**
   * A session this connection opened. Absent → the skills a session the
   * daemon creates NOW would have (a client opens its session lazily, at the
   * first prompt: its `/name` list is asked before it exists).
   */
  sessionId: SessionIdSchema.optional(),
});
export type SessionSkillsParams = z.infer<typeof SessionSkillsParamsSchema>;

export const SessionSkillsResultSchema = z.object({
  /** The skills a user can activate with `/name` (`session/prompt{skill}`); may be empty. */
  slash: z.array(SkillSummarySchema).max(MAX_SKILL_CATALOG),
  /** Every skill found, in precedence order. */
  skills: z.array(SkillListEntrySchema).max(MAX_SKILL_LIST),
  /** Discovery problems: skipped skills, warnings, shadowing, caps, removed ones. */
  problems: z.array(line(1000)).max(MAX_SKILL_PROBLEMS),
  moreProblems: z.number().int().nonnegative(),
});
export type SessionSkillsResult = z.infer<typeof SessionSkillsResultSchema>;
