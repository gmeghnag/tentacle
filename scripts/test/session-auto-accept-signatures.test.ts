/**
 * `feat/session-auto-accept`: its recorded sections name the model that WROTE
 * them (AGENTS §10, `*— <model-id>, <date>*`, "so we can see which model did
 * what on a task and how it behaved, and spot drift").
 *
 * This doc was the subject of three rounds of the same defect, so it is pinned
 * here rather than trusted:
 *   - **Review round 1, finding 5:** `## Execution` was signed
 *     `claude-sonnet-4-5`, which never ran the task.
 *   - **Fix round 1** corrected it to `deepseek` — the model FAMILY, not an id.
 *   - **Review round 2, finding 1:** `### Fix round 1` was signed
 *     `claude-opus-5-5, 2026-11-16` — the REVIEWER's id, and a date one day
 *     after the round ran. That round was executed by the deepseek executor:
 *     `night-session-auto-accept.log` records `07:02 deepseek done:`, and commit
 *     `347bf2d3` is dated 2026-11-15 07:02 +0100.
 *
 * Fix round 2 corrected all three and pinned them. The one id this repo's
 * deepseek executor has is `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`
 * (`~/.config/tentacle/config.jsonc`, the `deepseek` profile) — the id
 * `device-pairing.md` and `app-decomposition.md` sign that executor with.
 *
 * Why a doc-local test and not a rule for every doc: measured, NOT widened here
 * — across `docs/feat` + `docs/fix`, 162 exec+review section pairs name one
 * model, so a repo-wide version would be red on `main` and that class needs its
 * own `fix/` task (the same debt `task-doc-signatures.test.ts` records).
 *
 * The commit subject is deliberately NOT the expectation: `night-task.sh` hard-
 * codes `(deepseek)`/`(opus)` into the subject it writes, so it agrees with the
 * truth only by convention and could never redden this. The expectation is the
 * id, quoted from the source that assigns it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const DOC = join(ROOT, "docs", "feat", "session-auto-accept.md");

/** The id `~/.config/tentacle/config.jsonc`'s `deepseek` profile names. */
const DEEPSEEK = "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017";

/**
 * Every section that records EXECUTION, and the id its author really had.
 *
 * Fix round 2 is in this list signed by the REVIEWER's id on purpose: it was
 * executed by `claude-opus-5-5`, the same model that reviews — while its commit
 * subject says `(deepseek)`, because `night-task.sh` hard-codes that string for
 * the fix loop whatever executor it launched. A check that "agrees with the
 * commit" is therefore right only for the rounds the deepseek path ran; this
 * one is right about the model.
 */
const MUST_NAME_AUTHOR = [
  { heading: "Execution", id: DEEPSEEK, date: "2026-11-15" },
  { heading: "Fix round 1", id: DEEPSEEK, date: "2026-11-15" },
  { heading: "Fix round 2", id: "claude-opus-5-5", date: "2026-11-15" },
] as const;

/** A signature line, and the id it names (`*— id, date*`, optionally emphasised). */
const SIGNATURE = /^\*—\s*(?:\*\*)?([A-Za-z0-9._/-]+),\s*(\d{4}-\d{2}-\d{2})/;

/** Model FAMILIES — what a signature must not stop at (the Fix-round-1 shape). */
const NOT_AN_ID = new Set(["deepseek", "opus", "claude", "model", "model-id", "tbd"]);

interface Signature {
  readonly id: string | undefined;
  readonly date: string | undefined;
  /** 1-based line the signature sits on, or the heading's if it has none. */
  readonly at: number;
  /** True when the section's first non-blank line is a heading (a grouping). */
  readonly container: boolean;
}

/** The first signature under `## <head>` / `### <head>` (`^` so `Review` ≠ `Review notes`). */
function section(lines: readonly string[], head: string): Signature | undefined {
  const start = lines.findIndex((l) => l === `## ${head}` || l === `### ${head}`);
  if (start < 0) return undefined;
  const next = lines.slice(start + 1).find((l) => l.trim() !== "") ?? "";
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^#{2,4} /.test(line)) break;
    const m = SIGNATURE.exec(line);
    if (m !== null) return { id: m[1], date: m[2], at: i + 1, container: false };
    if (line.trim() !== "" && !line.startsWith("*—")) break;
  }
  return { id: undefined, date: undefined, at: start + 1, container: /^#{2,4} /.test(next) };
}

describe("feat/session-auto-accept: an executed section names the model that wrote it (§10)", () => {
  const lines = readFileSync(DOC, "utf8").split("\n");

  test("the scan finds the sections at all (non-vacuity: a blind scan would pass everything)", () => {
    // If a heading is renamed and the scan goes blind, `undefined` would sail
    // through the loop below — so assert the sections are really there first.
    for (const { heading } of MUST_NAME_AUTHOR) {
      expect(section(lines, heading)).toBeDefined();
    }
  });

  test("each names its author's real id — never another model's, never a family name", () => {
    const bad: string[] = [];
    for (const { heading, id, date } of MUST_NAME_AUTHOR) {
      const sig = section(lines, heading);
      if (sig === undefined) {
        bad.push(`"${heading}": section missing`);
        continue;
      }
      if (sig.id !== id) {
        // The historic shapes this catches, each named in the failure:
        // `claude-opus-5-5` on Fix round 1 (the reviewer's id, WRONG there) and
        // `deepseek` on Execution (the family name, before Fix round 2).
        bad.push(`line ${sig.at} "${heading}": "${sig.id ?? "(no signature)"}", want ${id}`);
      }
      if (sig.date !== date)
        bad.push(`line ${sig.at} "${heading}": dated ${sig.date ?? "?"}, ran ${date}`);
    }
    expect(bad).toEqual([]);
  });

  test("no signature stops at a model family (an id is a slug, not a vendor name)", () => {
    const families = MUST_NAME_AUTHOR.map(({ heading }) => section(lines, heading)?.id)
      .filter((id): id is string => id !== undefined)
      .filter((id) => NOT_AN_ID.has(id.toLowerCase()));
    expect(families).toEqual([]);
  });

  test("the two models are told apart — the record stays readable (§10)", () => {
    // §10's whole purpose for the signature: if every section named one model,
    // the different-model check would be unreadable. The review rounds are
    // opus's, the executor rounds deepseek's — and the doc says so.
    expect(section(lines, "Round 2")?.id).toBe("claude-opus-5-5");
    expect(section(lines, "Review")?.id).toBe("claude-opus-5-5");
    const ids = new Set(MUST_NAME_AUTHOR.map(({ heading }) => section(lines, heading)?.id));
    expect(ids.size).toBe(2);
  });
});
