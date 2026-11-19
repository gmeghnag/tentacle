/**
 * `feat/mobile-thinking-images`: its release artifact and its recorded sections
 * must not claim more than the branch builds, and must name who wrote them
 * (AGENTS §10 "so we can see which model did what on a task and how it behaved,
 * and spot drift").
 *
 * Both defects this pins were found by Review round 4 (2026-11-19), and both are
 * the same class the two sibling guards already cover for other docs
 * (`task-doc-signatures.test.ts`, `session-auto-accept-signatures.test.ts`):
 *
 *   1. **The fragment promised a layout the build does not have** (round 4
 *      finding 1). `b10be3fa` (S3) rewrote the changelog bullet to say a
 *      message's photos "sit ABOVE the text bubble" and "a photo-only message
 *      has no bubble at all". But S4 is the slice that draws it: `photoBlock` and
 *      `userRowParts` have NO consumer (`TranscriptRow.tsx:165` still calls
 *      `layoutMedia` inside the bubble), and this branch merges slice by slice
 *      (`1a2548e6`), so `bun run release` between S3 and S4 would promise users a
 *      layout they do not get.
 *   2. **The S3 section was signed `claude-sonnet-4-5`** (round 4 finding 2), a
 *      model that never ran this task: the slice ran on the deepseek executor
 *      (`night-mobile-thinking-images.log`: `03:58 deepseek done:`, commit
 *      `b10be3fa feat(mobile-thinking-images): exec (deepseek)`). §10's
 *      different-model check reads these ids, so a wrong one is unreadable
 *      evidence. This is the task's THIRD attribution mismatch (round 2 nit 3,
 *      round 3 nit 2), which is why it is pinned rather than trusted.
 *
 * The id the repo's deepseek executor has is `rits/deepseek-ai/DeepSeek-V4.1-Flash-1017`
 * (`~/.config/tentacle/config.jsonc`, the `deepseek` profile) — the id
 * `device-pairing.md`, `app-decomposition.md` and `session-auto-accept.md` sign
 * that executor with. The commit SUBJECT is deliberately not the expectation:
 * `night-task5.sh` hard-codes `(deepseek)`/`(opus)` into it, so subject-based
 * agreement could never redden this test.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dir, "..", "..");
const DOC = join(ROOT, "docs", "feat", "mobile-thinking-images.md");
const FRAGMENT = join(ROOT, "changelog.d", "mobile-thinking-images.changed.md");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
/** The bullet's headline: how it is found in CHANGELOG.md once a release consumed the fragment. */
const HEADLINE = '- **Mobile: the "Thinking" shimmer stays inside the letters';

/**
 * The bullet's text: the fragment while it is unreleased, else the line
 * `bun run release` assembled from it into CHANGELOG.md (v0.7.0 consumed it).
 */
function bulletText(): string {
  if (existsSync(FRAGMENT)) {
    return readFileSync(FRAGMENT, "utf8");
  }
  const line = readFileSync(CHANGELOG, "utf8")
    .split("\n")
    .find((l) => l.startsWith(HEADLINE));
  return line === undefined ? "" : `${line}\n`;
}
const MOBILE_SRC = join(ROOT, "apps", "mobile", "src");

/** The id `~/.config/tentacle/config.jsonc`'s `deepseek` profile names. */
const DEEPSEEK = "rits/deepseek-ai/DeepSeek-V4.1-Flash-1017";

/**
 * The photo layout S3 computed and S4 draws, each claim with the export whose
 * consumer makes it reachable. While the export has no consumer, a changelog
 * sentence that describes it promises code no user can run.
 */
const PHOTO_CLAIMS: readonly (readonly [RegExp, string])[] = [
  [/photos? now sit ABOVE the text bubble/i, "photoBlock"],
  [/photo-only message has no bubble/i, "userRowParts"],
];

/** The `## …`/`### …` sections that carry a record, and so take a signature. */
const WANT = /^(Execution\b|Fix round \d+|Review\b|Round \d+|S\d)/;

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

/**
 * Read a task doc's sections: heading, the signature id the section carries
 * anywhere inside it, and whether it groups others. Scanned to the next heading
 * (not just its first line) because this repo signs a `## Execution` at the END
 * of its lead prose (`mobile-thinking-images.md:125`, `:127`).
 */ function sections(text: string): Section[] {
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
    }
    out.push({ head, line: at, id, container: /^#{2,4} /.test(nextProse) });
  }
  return out;
}

/** Every source file under `apps/mobile/src` (this is a source pin, so it reads them). */
function mobileSources(): string[] {
  const files = [...new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: MOBILE_SRC, onlyFiles: true })];
  // A scan that found nothing would make the consumer check below vacuous.
  expect(files.length).toBeGreaterThan(100);
  return files;
}

/** True when `name` is imported or called anywhere outside its defining module. */
function hasConsumer(name: string, definingFile: string): boolean {
  const use = new RegExp(`\\b${name}\\b`);
  return mobileSources().some(
    (rel) => rel !== definingFile && use.test(readFileSync(join(MOBILE_SRC, rel), "utf8")),
  );
}

describe("the changelog bullet promises only what the branch builds", () => {
  const text = bulletText();

  test("the bullet is there (fragment, or released into CHANGELOG.md) and parses as one bullet (non-vacuity of the check below)", () => {
    expect(text.startsWith(HEADLINE)).toBe(true);
    expect(
      text
        .trim()
        .split("\n")
        .filter((l) => l.trim() !== ""),
    ).toHaveLength(1);
    expect(text).toMatch(/^- \*\*[^*]+\.\*\* /);
  });

  test("it does not promise the above-the-bubble layout while S3 is still unwired", () => {
    // Non-vacuity of the consumer scan itself, on two controls whose answer is
    // fixed: an export WITH a consumer must read true, an invented name false.
    // (Not "both S3 exports are unwired" — S4 legitimately ends that, and a
    // premise that reddens on the slice this task is FOR would only be deleted.)
    // (`layoutMedia` was the first control; S4 removed it with its last consumer.)
    expect(hasConsumer("displayUri", "media-layout.ts")).toBe(true);
    expect(hasConsumer("photoBlockButNotYet", "media-layout.ts")).toBe(false);
    // Nothing may promise what nothing renders. When S4 lands it adds the consumer
    // for each export, and that export's own sentence becomes legal in the same
    // commit — the two halves cannot drift apart silently.
    const orphaned = PHOTO_CLAIMS.filter(
      ([claim, exportName]) => claim.test(text) && !hasConsumer(exportName, "media-layout.ts"),
    ).map(([claim, exportName]) => `${String(claim)} (${exportName} has no consumer)`);
    expect(orphaned).toEqual([]);
  });
});

describe("the recorded sections name the model that wrote them (§10)", () => {
  const doc = readFileSync(DOC, "utf8");
  const recorded = sections(doc).filter((s) => WANT.test(s.head) && !s.container);

  test("the scan finds the sections at all (non-vacuity: an empty scan would pass everything)", () => {
    expect(recorded.length).toBeGreaterThanOrEqual(8);
    expect(recorded.filter((s) => /^S\d/.test(s.head)).length).toBeGreaterThanOrEqual(2);
    expect(recorded.filter((s) => /^Fix round/.test(s.head)).length).toBeGreaterThanOrEqual(1);
    expect(recorded.filter((s) => /^Round \d+/.test(s.head)).length).toBeGreaterThanOrEqual(3);
  });

  test("each one names a model id, not a placeholder", () => {
    const bad = recorded
      .filter((s) => s.id === undefined || NOT_AN_ID.has(s.id.toLowerCase()))
      .map((s) => `line ${s.line + 1} "${s.head}": ${s.id === undefined ? "no signature" : s.id}`);
    expect(bad).toEqual([]);
  });

  test("S3's as-built section carries the deepseek id its commit names, not another model", () => {
    // `b10be3fa feat(mobile-thinking-images): exec (deepseek)`, logged as
    // `03:58 deepseek done:` — and the plan assigns S3 to DeepSeek.
    const s3 = recorded.find((s) => /^S3\b/.test(s.head));
    expect(s3).toBeDefined();
    expect(s3?.id).toBe(DEEPSEEK);
    // The shape round 4 caught: a plausible id for a model that never ran it.
    expect(s3?.id).not.toBe("claude-sonnet-4-5");
    expect(s3?.id).not.toBe("claude-opus-5-5");
  });

  test("the reason is quoted from the run record, so the expectation cannot drift silently", () => {
    expect(DEEPSEEK).toBe("rits/deepseek-ai/DeepSeek-V4.1-Flash-1017");
  });
});
