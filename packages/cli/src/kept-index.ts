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

/** The entry's file: one per (engine, location, name) — a re-record replaces it. */
export function keptFileName(entry: KeptEntry): string {
  const key = [
    entry.engine,
    entry.endpoint ?? "",
    entry.context ?? "",
    entry.server ?? "",
    entry.namespace ?? "",
    entry.name,
  ].join("\0");
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
