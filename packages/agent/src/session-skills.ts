/**
 * A session's skill listing and the user's rescan rule
 * (docs/feat/skills-hot-reload.md). Pure: no I/O, no agent.
 *
 * The user's set (what `/name` may activate, and the `/skills` listing) follows
 * the disk at every rescan; the MODEL's set (its catalog in the system prompt
 * and the `skill` tool's enum) changes only at a context reset. So a rescan's
 * listing says what the model is offered NOW, not what the disk would offer.
 */

/** One skill as a session lists it (`session/skills`, before the daemon makes it wire-safe). */
export interface SkillListingEntry {
  readonly name: string;
  readonly description: string;
  readonly scope: "project" | "user";
  /** Offered to the user as `/name`. */
  readonly user: boolean;
  /** Offered to the model in this session now. */
  readonly model: boolean;
  /** Not offered to the model now, but the disk offers it: it is at the next context reset. */
  readonly modelAfterReset?: boolean;
  readonly location: string;
}

export interface SkillListing {
  readonly skills: readonly SkillListingEntry[];
  /** Discovery problems, then one line per skill the model keeps but the disk no longer has. */
  readonly problems: readonly string[];
}

export const EMPTY_SKILL_LISTING: SkillListing = { skills: [], problems: [] };

/**
 * The listing after a user rescan: `fresh` (a discovery's own listing, where
 * `model` means "the disk offers it to the model") seen from a session whose
 * model is offered `modelNow`. `model` becomes "offered now"; a skill the
 * disk offers but the model does not have yet is marked `modelAfterReset`; a
 * skill the model still has but the disk no longer does gets a problem line.
 */
export function userRescanListing(fresh: SkillListing, modelNow: readonly string[]): SkillListing {
  const offeredNow = new Set(modelNow);
  const onDisk = new Set(fresh.skills.map((s) => s.name));
  return {
    skills: fresh.skills.map(({ modelAfterReset: _drop, ...s }) => {
      const model = offeredNow.has(s.name);
      return { ...s, model, ...(s.model && !model ? { modelAfterReset: true } : {}) };
    }),
    problems: [
      ...fresh.problems,
      ...modelNow
        .filter((name) => !onDisk.has(name))
        .map((name) => `${name}: removed — the model keeps it until a context reset`),
    ],
  };
}
