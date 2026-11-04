/**
 * The laptop-side index of kept workloads (docs/feat/engine-ps-rm.md, owner
 * E-Q1): `<configDir>/kept/<id>.json`, ONE file per workload, so two CLIs
 * writing at once never read-modify-write the same file (no lost entry, no
 * lock). A file is written atomically (temp + rename): a crash leaves the old
 * file or none, never half of one. A file that does not parse — corrupt, or
 * another `schemaVersion` — is REPORTED and left untouched, never deleted or
 * half-loaded (AGENTS §7 on-disk records). Laptop only: pod daemons never
 * see it. Locators only — no credentials (`KeptEntry`).
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type KeptEntry, parseKeptEntry } from "./kept.ts";

export const keptDir = (configDir: string): string => join(configDir, "kept");

/** Where a workload lives, as one value: two equal keys are the same place. */
export function locationKey(
  at: Pick<KeptEntry, "engine" | "endpoint" | "context" | "server" | "namespace">,
): string {
  return [at.engine, at.endpoint ?? "", at.context ?? "", at.server ?? "", at.namespace ?? ""].join(
    "\0",
  );
}

/** The entry's file: one per (engine, location, name) — a re-record replaces it. */
export function keptFileName(entry: KeptEntry): string {
  const key = `${locationKey(entry)}\0${entry.name}`;
  return `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`;
}

export interface KeptFile {
  readonly file: string;
  readonly entry: KeptEntry;
}

export interface KeptIndex {
  readonly entries: readonly KeptFile[];
  /** Files refused (left untouched): `file: why`. */
  readonly problems: readonly string[];
}

/** The file ops `recordKept` uses (a test seam for the crash-mid-write case). */
export interface KeptWriteFs {
  readonly rename: (from: string, to: string) => void;
}

/** Record (or replace) an entry atomically; returns its file. Throws on failure. */
export function recordKept(
  dir: string,
  entry: KeptEntry,
  fs: KeptWriteFs = { rename: renameSync },
): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, keptFileName(entry));
  // Dot-prefixed: `readKept` never takes a temp file for an entry.
  const temp = join(dir, `.${randomUUID()}.tmp`);
  writeFileSync(temp, `${JSON.stringify(entry, null, 2)}\n`, { mode: 0o600 });
  try {
    fs.rename(temp, file);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return file;
}

/** Every entry; a missing dir is an empty index. */
export function readKept(dir: string): KeptIndex {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], problems: [] };
    }
    return {
      entries: [],
      problems: [`${dir}: cannot be read (${(error as NodeJS.ErrnoException).code ?? error})`],
    };
  }
  const entries: KeptFile[] = [];
  const problems: string[] = [];
  for (const name of names.sort()) {
    if (name.startsWith(".") || !name.endsWith(".json")) {
      continue;
    }
    const file = join(dir, name);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      problems.push(`${file}: cannot be read (${(error as NodeJS.ErrnoException).code ?? error})`);
      continue;
    }
    const parsed = parseKeptEntry(text);
    if (parsed.ok) {
      entries.push({ file, entry: parsed.entry });
    } else {
      problems.push(`${file}: ${parsed.problem}`);
    }
  }
  return { entries, problems };
}

/** Drop an entry (already gone is fine). */
export function forgetKept(file: string): void {
  rmSync(file, { force: true });
}

/**
 * Record the laptop session a kept workload last saved (docs/fix/attach-plain-resume.md):
 * what a plain `attach` reopens. A read-modify-write of the entry's OWN file, only if it
 * still exists and is still THIS workload's (`created`): a `tentacle rm` is not undone,
 * and a re-run under the same name is not touched by the old process. `false`: not written
 * for that reason. Throws on a write failure.
 */
export function setKeptSession(dir: string, entry: KeptEntry, sessionId: string): boolean {
  let text: string;
  try {
    text = readFileSync(join(dir, keptFileName(entry)), "utf8");
  } catch {
    return false;
  }
  const parsed = parseKeptEntry(text);
  if (!parsed.ok || parsed.entry.created !== entry.created) {
    return false;
  }
  if (parsed.entry.sessionId !== sessionId) {
    recordKept(dir, { ...parsed.entry, sessionId });
  }
  return true;
}

/** The in-TUI notice for a failing `trackKeptSession` write. */
export const keptSessionNotice = (message: string): string =>
  `⚠ Could not record this conversation in the kept index (${message}): a later attach will start a new one.`;

/**
 * Keep `entry`'s `sessionId` at the latest session the saver saves (a `/clear` or
 * `/resume` makes another uid). Writes only on a change; a failing write is `onError`
 * once, never thrown into the saver.
 */
export function trackKeptSession(
  saver: { observe: (listener: (record: { readonly id: string }) => void) => void },
  dir: string,
  entry: KeptEntry,
  onError: (message: string) => void,
): void {
  let written = entry.sessionId;
  let failed = false;
  saver.observe((record) => {
    if (record.id === written) {
      return;
    }
    try {
      setKeptSession(dir, entry, record.id);
      written = record.id;
      failed = false;
    } catch (error) {
      if (!failed) {
        failed = true;
        onError(error instanceof Error ? error.message : String(error));
      }
    }
  });
}
