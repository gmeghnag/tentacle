/**
 * The skills that ship inside tentacle (docs/feat/builtin-skills.md): their
 * names and which of them a host seeds OFF. Pure: the text of the skills lives
 * in `@tentacle/config` (`builtin-skills.ts`).
 */

/** Every built-in skill's name (also its directory's). Sorted. */
export const BUILTIN_SKILL_NAMES: readonly string[] = [
  "tentacle",
  "tentacle-a2a",
  "tentacle-workflows",
];

/** Whether `name` is a built-in skill's name. */
export function isBuiltinSkillName(name: string): boolean {
  return BUILTIN_SKILL_NAMES.includes(name);
}

/**
 * The names a new session starts with turned off: every WINNING skill that is a
 * built-in (a user or project skill shadowing one is not `builtin`, so it is
 * never seeded off) not set `true` in `skills.builtin`. Sorted.
 */
export function builtinDefaultOff(
  skills: readonly { readonly name: string; readonly builtin?: boolean }[],
  enabled: Readonly<Record<string, boolean>>,
): string[] {
  return skills
    .filter((s) => s.builtin === true && enabled[s.name] !== true)
    .map((s) => s.name)
    .sort();
}
