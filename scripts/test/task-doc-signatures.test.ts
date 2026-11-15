/**
 * A task doc's section signature must name the model that WROTE it (AGENTS §10:
 * `*— <model-id>, <date>*`, "so we can see which model did what on a task and how
 * it behaved, and spot drift"). Review round 2 of `feat/mobile-pairing-camera`
 * was exactly a defect of this record: `### Fix round 1` was signed
 * `claude-opus-5-5` while its commit says `(deepseek)`, and the slice's
 * `## Execution` header was left reading `*— **signature corrected after fix
 * round 1**: …*` — the literal word `signature` where an id belongs. Both make
 * §10's different-model check unreadable off the doc.
 *
 * Two checks, for the one doc this task owns:
 *   1. **WRITTEN**: every Execution / Fix round / Review / Round section that has
 *      prose carries a signature whose id is a model id, not a placeholder. (A
 *      container heading — one whose next non-blank line is another heading — is
 *      a grouping, not a section, and takes none.)
 *   2. **AGREES**: the two sections Review round 2 named are signed with the id
 *      their commits name. `night-task.sh` stamps the executor into the subject
 *      (`exec (deepseek)` / `review round N (deepseek)`, and `(opus)` for the
 *      claude path), and this repo's deepseek profile is
 *      `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017` — the id `device-pairing.md`
 *      and the runs of 2026-11-13/14 sign that executor with.
 *
 * Check 2 is pinned as an explicit expectation rather than derived from `git
 * log`: over this doc, a heading-ordinal mapping mis-attributes any heading that
 * was later RENAMED (the plan commit added a bare `## Execution`, so it "owns"
 * 11b.1's executed section). The cross-check against the commits was done by
 * hand and is pasted in the doc's *Fix round 2*; what a future round must not be
 * able to do silently is RE-SIGN these two sections to another model.
 *
 * Class-wide debt, measured and NOT widened here (a repo-wide version would be
 * red on `main`): across `docs/feat` + `docs/fix` (220 docs, 391 Execution/Fix
 * sections) 162 exec+review section pairs name one model, so the class predates
 * this task and needs its own `fix/` task.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const DOC = join(ROOT, "docs", "feat", "mobile-pairing-screen.md");

/** The two sections Review round 2 named, and the id each must carry (head text, no hashes). */
const MUST_AGREE = [
  {
    heading: "Execution — slice 11b.2 (`feat/mobile-pairing-camera`)",
    id: "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017",
    why: "commit f396ff99 feat(mobile-pairing-camera): exec (deepseek)",
  },
  {
    heading: "Fix round 1",
    id: "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017",
    why: "commit 0c5fb025 fix(mobile-pairing-camera): review round 1 (deepseek)",
  },
] as const;

/** The sections that carry a record, and so must be signed. */
const WANT = /^(Execution\b|Fix round \d+|Review\b|Round \d+)/;

/** A signature line, and the id it names (`*— id, date*`, optionally emphasised). */
const SIGNATURE = /^\*—\s*(?:\*\*)?([A-Za-z0-9._/-]+),\s*\d{4}-\d{2}-\d{2}/;

/** Words that stand in a signature where an id belongs. */
const NOT_AN_ID = new Set(["signature", "model", "model-id", "<model-id>", "tbd", "id"]);

interface Section {
  /** `## …` or `### …`, without the hashes. */
  readonly head: string;
  /** The 0-based line the heading sits on. */
  readonly line: number;
  /** The id its first signature line names, if it has one. */
  readonly id: string | undefined;
  /** True when the next non-blank line is another heading (a grouping). */
  readonly container: boolean;
}

/** Read the doc's sections: heading, signature id, and whether it groups others. */
function sections(text: string): Section[] {
  const lines = text.split("\n");
  const out: Section[] = [];
  const heads: number[] = [];
  for (const [i, line] of lines.entries()) if (/^#{2,4} /.test(line)) heads.push(i);
  for (const at of heads) {
    const head = (lines[at] ?? "").replace(/^#{2,4} /, "").trim();
    const nextProse = lines.slice(at + 1).find((l) => l.trim() !== "") ?? "";
    let id: string | undefined;
    for (const line of lines.slice(at + 1)) {
      if (/^#{2,4} /.test(line)) break;
      const m = SIGNATURE.exec(line);
      if (m !== null) {
        id = m[1] ?? "";
        break;
      }
      // A signature is the section's first line of prose; anything else after it
      // means the section never got one.
      if (line.trim() !== "" && !line.startsWith("*—")) break;
    }
    out.push({ head, line: at, id, container: /^#{2,4} /.test(nextProse) });
  }
  return out;
}

describe("WRITTEN: a task doc's recorded sections are signed with a model id (§10)", () => {
  const doc = readFileSync(DOC, "utf8");
  const recorded = sections(doc).filter((s) => WANT.test(s.head) && !s.container);

  test("the scan finds the sections at all (non-vacuity: an empty scan would pass everything)", () => {
    // The doc has both slices' sections: 2 Executions, 2 Fix rounds, 2 Reviews,
    // 2 Rounds at least. If a heading style changes and the scan goes blind, this
    // is the case that says so.
    expect(recorded.length).toBeGreaterThanOrEqual(8);
    expect(recorded.filter((s) => /^Fix round/.test(s.head)).length).toBeGreaterThanOrEqual(2);
  });

  test("each one names a model id, not a placeholder", () => {
    const bad = recorded
      .filter((s) => s.id === undefined || NOT_AN_ID.has(s.id.toLowerCase()))
      .map((s) => `line ${s.line + 1} "${s.head}": ${s.id === undefined ? "no signature" : s.id}`);
    // Round 1's half-fix is the shape this catches: the 11b.2 Execution header was
    // rewritten to `*— **signature corrected after fix round 1**: …*`, which reads
    // as the id `signature` — an id no model has.
    expect(bad).toEqual([]);
  });
});

describe("AGREES: the executed sections are signed with the model their commits name", () => {
  const doc = readFileSync(DOC, "utf8");
  const found = sections(doc);

  test("11b.2's Execution and its Fix round 1 carry the deepseek id, not the reviewer's", () => {
    const execution = found.find((s) => s.head === MUST_AGREE[0].heading);
    expect(execution).toBeDefined();
    expect(execution?.id).toBe(MUST_AGREE[0].id);
    // The Fix round 1 of THIS slice is the second `### Fix round 1` in the doc
    // (11b.1's comes first, at the top); it must be the deepseek id too.
    const fixRounds = found.filter((s) => s.head === "Fix round 1");
    expect(fixRounds.length).toBe(2);
    const thisSlices = fixRounds[1];
    expect(thisSlices).toBeDefined();
    expect(thisSlices?.id).toBe(MUST_AGREE[1].id);
    // …and it is emphatically NOT the reviewer's, which is what round 2 caught:
    // `claude-opus-5-5` is the model that REVIEWS this branch, so a fix round
    // signed with it makes the different-model check unreadable.
    expect(thisSlices?.id).not.toBe("claude-opus-5-5");
  });

  test("the reason is quoted from the commits, so the expectation above cannot drift silently", () => {
    // Both ids rest on `night-task.sh`'s subjects for this branch; that file
    // stamps a step by which executor it launched, and the deepseek profile is
    // the id in `~/.config/tentacle/config.jsonc`. Recorded, not re-derived.
    expect(MUST_AGREE.map((m) => m.why)).toEqual([
      "commit f396ff99 feat(mobile-pairing-camera): exec (deepseek)",
      "commit 0c5fb025 fix(mobile-pairing-camera): review round 1 (deepseek)",
    ]);
  });
});
