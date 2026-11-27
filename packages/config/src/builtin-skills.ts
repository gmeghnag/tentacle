/**
 * The skills that ship inside tentacle (docs/feat/builtin-skills.md): their
 * sources live in `packages/config/builtin-skills/<name>/` and are EMBEDDED in
 * this build as text, so they work from the compiled binary (and a pod's).
 * `skills-scan.ts` writes them under `<configDir>/builtin-skills/<hash>/` and
 * scans that dir like any other root. Names and off-by-default rule:
 * `@tentacle/core` `builtin-skills.ts`.
 *
 * Blocks between `<!-- generated:<id> -->` markers are written by
 * `bun run skills:gen`; `packages/cli/test/builtin-skills.test.ts` fails while
 * one is stale or a file is missing from the table below.
 */
import { createHash } from "node:crypto";
// @ts-expect-error see above
import a2a from "../builtin-skills/tentacle-a2a/SKILL.md" with { type: "text" };
// Each `@ts-expect-error`: TS cannot type a Markdown file imported AS TEXT
// (TS2307); Bun inlines its content as a string.
// @ts-expect-error see above
import agentCard from "../builtin-skills/tentacle-a2a/references/agent-card.md" with {
  type: "text",
};
// @ts-expect-error see above
import workflows from "../builtin-skills/tentacle-workflows/SKILL.md" with { type: "text" };
// @ts-expect-error see above
import tentacle from "../builtin-skills/tentacle/SKILL.md" with { type: "text" };

/** Skill name → path inside its directory → text. */
export const BUILTIN_SKILL_FILES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  tentacle: { "SKILL.md": tentacle },
  "tentacle-a2a": { "SKILL.md": a2a, "references/agent-card.md": agentCard },
  "tentacle-workflows": { "SKILL.md": workflows },
};

/** Every file as `[<name>/<path>, text]`, sorted by path. */
export function builtinSkillEntries(): [string, string][] {
  return Object.entries(BUILTIN_SKILL_FILES)
    .flatMap(([name, files]) =>
      Object.entries(files).map(([path, text]): [string, string] => [`${name}/${path}`, text]),
    )
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 16 hex of sha-256 over the sorted (path, bytes) table: two builds with
 * different text never share a directory, identical builds do.
 */
export function builtinSkillsHash(): string {
  const hash = createHash("sha256");
  for (const [path, text] of builtinSkillEntries()) {
    hash.update(`${path}\0${Buffer.byteLength(text)}\0${text}`);
  }
  return hash.digest("hex").slice(0, 16);
}
