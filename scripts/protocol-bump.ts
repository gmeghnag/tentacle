/**
 * `bun run protocol:bump` — assign `PROTOCOL_VERSION` at MERGE time, from the
 * per-task notes in `protocol.d/` (docs/feat/protocol-version-at-merge.md).
 *
 * Why: the number (`packages/protocol/src/version.ts:32`) is one shared line, so
 * two parallel tasks that each bump it conflict — in the reason prose, which is
 * hand-resolved every time. A task therefore records only WHY the wire breaks,
 * in its own file `protocol.d/<slug>.md`; the orchestrator runs this once after
 * the merge, and every note there takes the next number, in slug order.
 *
 * A note is one file, one reason, named for the task slug — so two tasks never
 * write one path (the shape `changelog.d/` proved, scripts/changelog.ts).
 *
 * The rules are pure (`parseNotes` / `applyBump`); the shell (`runProtocolBump`)
 * does the disk, the deletion and the `schema:export` refresh. `schema:export`
 * is not optional: `schema/protocol.json` carries `x-protocol-version`
 * (`:4383`) and `packages/protocol/test/json-schema.test.ts:39` fails on drift,
 * so a bump that skips it is red anyway — one command does both.
 */
import { readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ReleaseError } from "./release-plan.ts";

/** Where a task records a breaking protocol change (repo-relative). */
export const NOTE_DIR = "protocol.d";

/** The file the number and its reason comments live in (repo-relative). */
export const VERSION_PATH = "packages/protocol/src/version.ts";

/** A task slug: lowercase letters, digits and dashes, not starting with a dash. */
const SLUG = /^[a-z0-9][a-z0-9-]*$/;

/** The `export const PROTOCOL_VERSION = <n> as const;` line, exactly once. */
const NUMBER_LINE = /^export const PROTOCOL_VERSION = (\d+) as const;$/m;

/** One `// <n>: <text>` reason comment, and its continuation lines. */
const COMMENT_LINE = /^\/\/ (\d+): (.*)$/;

/** One validated note: the file it came from, plus the reason text. */
export interface Note {
  readonly path: string;
  readonly slug: string;
  /** The reason, one line per array entry (a note's blank-line-separated prose). */
  readonly text: string;
}

/** A note file as read from disk (`path` is repo-relative). */
export interface NoteFile {
  readonly path: string;
  readonly text: string;
  /** Set when the entry is a directory: refused by name. */
  readonly directory?: boolean;
}

/**
 * Read EVERY entry in `<root>/protocol.d/` — files, directories and dotfiles.
 * The name check is `parseNotes`'s, not a glob's: a `*.md` filter would never
 * parse `lost-task` or `sub/nested.md`, so a break would be recorded and never
 * applied, and nothing would go red (the F1 lesson, scripts/changelog.ts).
 *
 * A missing `protocol.d/` is the normal state (no breaking change in flight).
 */
export function readNoteDir(root: string): NoteFile[] {
  const dir = join(root, NOTE_DIR);
  const names = (() => {
    try {
      return readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
  })();
  return names
    .map((entry) => ({ path: `${NOTE_DIR}/${entry.name}`, full: join(dir, entry.name) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map(({ path, full }) =>
      statSync(full).isDirectory()
        ? { path, text: "", directory: true }
        : { path, text: readFileSync(full, "utf8") },
    );
}

/** Validate one note file; throws `ReleaseError` naming the offence. */
function parseNote({ path, text, directory }: NoteFile): Note {
  const name = path.startsWith(`${NOTE_DIR}/`) ? path.slice(NOTE_DIR.length + 1) : "";
  if (directory === true || name.includes("/")) {
    throw new ReleaseError(`${path}: ${NOTE_DIR}/ holds note files only, no subdirectories`);
  }
  const stem = name.endsWith(".md") ? name.slice(0, -".md".length) : "";
  if (stem === "" || !SLUG.test(stem)) {
    throw new ReleaseError(
      `${path}: a note is named <slug>.md, the task slug (lowercase letters, digits and dashes)`,
    );
  }
  const body = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .join(" ");
  if (body === "") {
    throw new ReleaseError(`${path}: note is empty; it says what the wire break is and why`);
  }
  return { path, slug: stem, text: body };
}

/** Validate every note, sorted by slug — the order the numbers are assigned in. */
export function parseNotes(files: readonly NoteFile[]): Note[] {
  return files.map(parseNote).sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
}

/**
 * The reason block in `version.ts`: one entry per `// <n>: ` line, with its
 * `// ` continuation lines joined back into the text. Joining matters — the
 * idempotence check in `pendingNotes` compares a note's prose to this text, so a
 * wrapped note must read back as the prose it was wrapped from.
 */
export function readBumps(versionText: string): { number: number; text: string }[] {
  const out: { number: number; text: string }[] = [];
  for (const line of versionText.split("\n")) {
    const start = COMMENT_LINE.exec(line);
    if (start !== null) {
      out.push({ number: Number(start[1]), text: start[2] ?? "" });
    } else if (line.startsWith("// ") && !/^\/\/ \d+: /.test(line)) {
      const last = out[out.length - 1];
      if (last !== undefined) {
        last.text = `${last.text} ${line.slice("// ".length)}`.trim();
      }
    }
  }
  return out;
}

/** The current `PROTOCOL_VERSION`, or a refusal when the line is not exactly one. */
export function readVersion(versionText: string): number {
  const hits = [...versionText.matchAll(new RegExp(NUMBER_LINE.source, "gm"))];
  const only = hits[0];
  if (hits.length !== 1 || only === undefined) {
    throw new ReleaseError(
      `${VERSION_PATH}: expected exactly one "export const PROTOCOL_VERSION = <n> as const;" line (found ${hits.length})`,
    );
  }
  return Number(only[1]);
}

/**
 * Wrap a note's prose into `// ` continuation lines (Biome's 100-col width), so a
 * long reason is still one comment block, and each new number gets exactly one
 * `// <n>: ` first line (`readBumps` reads that).
 */
export function foldNote(number: number, text: string, width = 88): string[] {
  const prefix = `// ${number}: `;
  const words = text.split(" ");
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line === "" ? word : `${line} ${word}`;
    if (line !== "" && `${prefix}${candidate}`.length > width) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
  }
  if (line !== "") {
    lines.push(line);
  }
  return lines.map((l, i) => (i === 0 ? `${prefix}${l}` : `// ${l}`));
}

/**
 * The notes not yet folded: a note whose reason is already the newest block's
 * text has been applied (a crash between "written" and "note deleted"), so it is
 * skipped rather than folded twice. Shared by `applyBump` and the shell so the
 * count it prints is the count it folded.
 */
export function pendingNotes(versionText: string, notes: readonly Note[]): Note[] {
  const bumps = readBumps(versionText);
  const newest = bumps[bumps.length - 1];
  return notes.filter((note) => !(newest !== undefined && newest.text === note.text));
}

/**
 * Fold every note into `version.ts`: one `// <n>: <reason>` block per note, in
 * slug order, and the number set to the last one assigned.
 *
 * Refused (the honest states, each of which would otherwise be silent):
 * - the block already disagrees with the number (a hand-bump, or an edit to one
 *   and not the other);
 * - the numbers are not strictly ascending (a block edited out of order);
 * - a number already appears twice (a note folded twice).
 */
export function applyBump(versionText: string, notes: readonly Note[]): string {
  const current = readVersion(versionText);
  const bumps = readBumps(versionText);
  const newest = bumps[bumps.length - 1];
  if (newest !== undefined && newest.number !== current) {
    throw new ReleaseError(
      `${VERSION_PATH}: the number is ${current} but the newest reason comment is ${newest.number} — bump both or neither`,
    );
  }
  const numbers = bumps.map((b) => b.number);
  for (let i = 1; i < numbers.length; i += 1) {
    const previous = numbers[i - 1] ?? 0;
    const here = numbers[i] ?? 0;
    if (here !== previous + 1) {
      throw new ReleaseError(
        `${VERSION_PATH}: reason comments must number consecutively; got ${previous} then ${here}`,
      );
    }
  }
  const pending = pendingNotes(versionText, notes)
    .slice()
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  if (pending.length === 0) {
    return versionText;
  }
  const blocks = pending.map((note, i) => foldNote(current + 1 + i, note.text));
  const assigned = current + pending.length;
  const folded = blocks.map((b) => `${b.join("\n")}\n`).join("");
  return versionText
    .replace(NUMBER_LINE, `export const PROTOCOL_VERSION = ${assigned} as const;`)
    .replace(NUMBER_LINE, (line) => `${folded}${line}`);
}

/** What the shell needs, injectable so the tests drive no real git or export. */
export interface ProtocolBumpDeps {
  readonly root: string;
  /** `bun run schema:export`; resolves `true` when green. Injected in tests. */
  readonly exportSchema: () => Promise<boolean>;
  readonly write: (text: string) => void;
  /**
   * The one disk write, injectable so a test can prove the ORDER: notes are
   * deleted after this lands, never before (mutation: delete first → the note is
   * gone and the number was never bumped, an unrecoverable silent loss).
   */
  readonly writeVersion?: (path: string, text: string) => void;
}

/**
 * Run the bump. Zero notes is NOT an error: with nothing to fold this is still
 * the post-merge "regenerate `protocol.json`" step (docs/feat/changelog-fragments.md
 * Q4), so one command covers both and the orchestrator cannot forget the second.
 *
 * Everything is computed before the first write, so a malformed note leaves the
 * tree exactly as it was (scripts/release.ts's order).
 */
export async function runProtocolBump(deps: ProtocolBumpDeps): Promise<number> {
  const { root, write } = deps;
  try {
    const files = readNoteDir(root);
    const notes = parseNotes(files);
    const path = join(root, VERSION_PATH);
    const before = readFileSync(path, "utf8");
    const after = applyBump(before, notes);
    const pending = pendingNotes(before, notes);
    if (after !== before) {
      (deps.writeVersion ?? writeFileSync)(path, after);
      const version = readVersion(after);
      const first = version - pending.length + 1;
      const lines = pending.map((note, i) => `  ${NOTE_DIR}/${note.slug}.md → // ${first + i}`);
      write(
        `${VERSION_PATH}: ${pending.length} note${pending.length === 1 ? "" : "s"} folded, PROTOCOL_VERSION is now ${version}\n${lines.join("\n")}\n`,
      );
    } else {
      write(
        `${VERSION_PATH}: no new ${NOTE_DIR}/ notes; PROTOCOL_VERSION stays ${readVersion(before)}\n`,
      );
    }
    // Delete only AFTER the write landed: a crash in between leaves the note,
    // and the re-run skips it (applyBump's idempotence) instead of doubling it.
    for (const note of notes) {
      rmSync(join(root, note.path), { force: true });
    }
    write("refreshing packages/protocol/schema/protocol.json…\n");
    if (!(await deps.exportSchema())) {
      throw new ReleaseError(
        `bun run schema:export failed: protocol.json must be regenerated for version ${readVersion(after)}`,
      );
    }
    write(
      pending.length === 0
        ? "done. Stage packages/protocol/schema/protocol.json if it changed (the generated file must never be hand-merged).\n"
        : `done. Stage ${VERSION_PATH}, the ${NOTE_DIR}/ deletions and packages/protocol/schema/protocol.json.\n`,
    );
    return 0;
  } catch (error) {
    write(`protocol:bump: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const code = await runProtocolBump({
    root,
    exportSchema: async () => {
      const proc = Bun.spawn(["bun", "run", "schema:export"], {
        cwd: root,
        stdout: "inherit",
        stderr: "inherit",
      });
      return (await proc.exited) === 0;
    },
    write: (text) => process.stdout.write(text),
  });
  process.exit(code);
}
