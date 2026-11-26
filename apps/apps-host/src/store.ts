/**
 * The host's disk (docs/feat/session-apps-host.md, "Store"). Every file is
 * written whole to a temporary name, synced, then renamed; content files are
 * named by their hash, so a new version never overwrites a served one.
 */
import * as fsp from "node:fs/promises";
import { join } from "node:path";
import { isAppId } from "@tentacle/protocol";
import { type AppRecord, type ContentRef, type LeaseSnapshot, contentTag } from "./records.ts";

export interface Report {
  readonly at: number;
  readonly ip: string;
  readonly app: string;
  readonly reason: string;
  readonly details: string;
  readonly contact: string;
}

export interface Loaded {
  records: AppRecord[];
  /** Ids whose record cannot be read by this build: left untouched. */
  skipped: string[];
  contents: ContentRef[];
  snapshot?: LeaseSnapshot;
  /** What to log about files that could not be used. */
  problems: string[];
}

/** A `Bun.file` from the disk (never read whole), or bytes from a test's store. */
export type Content = ReturnType<typeof Bun.file> | Uint8Array;

export interface Store {
  /** Read everything, removing temporary files a crash left. */
  load(): Promise<Loaded>;
  writeContent(id: string, sha256: string, bytes: Uint8Array): Promise<void>;
  writeRecord(record: AppRecord): Promise<void>;
  removeContent(id: string, sha256: string): Promise<void>;
  removeRecord(id: string): Promise<void>;
  /** The content, as something a `Response` serves; `undefined` if it is gone. */
  content(id: string, sha256: string): Promise<Content | undefined>;
  writeSnapshot(snapshot: LeaseSnapshot): Promise<void>;
  appendReport(report: Report): Promise<void>;
  /** Remove the report files holding anything older than `cutoff`. */
  pruneReports(cutoff: number): Promise<void>;
  freeBytes(): Promise<number>;
}

interface Handle {
  writeFile(data: Uint8Array | string): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

/** The slice of `node:fs/promises` the store uses (injected to fail it). */
export interface StoreFs {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  open(path: string, flags: string, mode: number): Promise<Handle>;
  rename(from: string, to: string): Promise<void>;
  unlink(path: string): Promise<void>;
  readdir(path: string): Promise<string[]>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  appendFile(path: string, data: string, options: { mode: number }): Promise<void>;
  statfs(path: string): Promise<{ bavail: number; bsize: number }>;
}

const FILE_MODE = 0o600;
const DIR_MODE = 0o700;
const STATES = new Set(["live", "expired", "deleted", "taken_down"]);

const isCode = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as { code?: unknown }).code === code;

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function parseRecord(text: string, id: string): AppRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const valid =
    isObject(value) &&
    value.v === 1 &&
    value.id === id &&
    typeof value.ownerKey === "string" &&
    typeof value.state === "string" &&
    STATES.has(value.state) &&
    typeof value.sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(value.sha256) &&
    typeof value.bytes === "number" &&
    typeof value.createdAt === "number" &&
    typeof value.updatedAt === "number";
  return valid ? (value as unknown as AppRecord) : undefined;
}

function parseSnapshot(text: string): LeaseSnapshot | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  const valid =
    isObject(value) &&
    value.v === 1 &&
    typeof value.aliveAt === "number" &&
    isObject(value.leases) &&
    Object.values(value.leases).every((lease) => typeof lease === "number");
  return valid ? (value as unknown as LeaseSnapshot) : undefined;
}

export function createFsStore(dir: string, fs: StoreFs = fsp): Store {
  const apps = join(dir, "apps");
  const reports = join(dir, "reports");
  const snapshotPath = join(dir, "leases.json");
  const recordPath = (id: string): string => join(apps, `${id}.json`);
  const contentPath = (id: string, sha256: string): string =>
    join(apps, `${id}-${contentTag(sha256)}.html`);
  let writes = 0;

  const remove = async (path: string): Promise<void> => {
    try {
      await fs.unlink(path);
    } catch (error) {
      if (!isCode(error, "ENOENT")) {
        throw error;
      }
    }
  };

  const writeAtomic = async (path: string, data: Uint8Array | string): Promise<void> => {
    writes += 1;
    const temporary = `${path}.${process.pid}-${writes}.tmp`;
    try {
      const handle = await fs.open(temporary, "w", FILE_MODE);
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await fs.rename(temporary, path);
    } catch (error) {
      await remove(temporary).catch(() => {});
      throw error;
    }
  };

  const names = async (path: string): Promise<string[]> => {
    const found: string[] = [];
    for (const name of await fs.readdir(path)) {
      if (name.endsWith(".tmp")) {
        await remove(join(path, name));
      } else {
        found.push(name);
      }
    }
    return found.sort();
  };

  return {
    async load(): Promise<Loaded> {
      await fs.mkdir(apps, { recursive: true, mode: DIR_MODE });
      await fs.mkdir(reports, { recursive: true, mode: DIR_MODE });
      const loaded: Loaded = { records: [], skipped: [], contents: [], problems: [] };
      for (const name of await names(dir)) {
        if (name !== "leases.json") {
          continue;
        }
        const snapshot = parseSnapshot(await fs.readFile(snapshotPath, "utf8").catch(() => ""));
        if (snapshot === undefined) {
          loaded.problems.push("leases.json invalid");
        } else {
          loaded.snapshot = snapshot;
        }
      }
      for (const name of await names(apps)) {
        const content = /^([a-z2-7]{16})-([0-9a-f]{16})\.html$/.exec(name);
        if (content !== null) {
          loaded.contents.push({ id: content[1] ?? "", tag: content[2] ?? "" });
          continue;
        }
        const id = name.endsWith(".json") ? name.slice(0, -".json".length) : "";
        if (!isAppId(id)) {
          continue;
        }
        const text = await fs.readFile(recordPath(id), "utf8").catch(() => "");
        const record = parseRecord(text, id);
        if (record === undefined) {
          loaded.skipped.push(id);
          loaded.problems.push(`record ${id} skipped: unreadable or unknown version`);
        } else {
          loaded.records.push(record);
        }
      }
      return loaded;
    },
    writeContent: (id, sha256, bytes) => writeAtomic(contentPath(id, sha256), bytes),
    writeRecord: (record) => writeAtomic(recordPath(record.id), JSON.stringify(record)),
    removeContent: (id, sha256) => remove(contentPath(id, sha256)),
    removeRecord: (id) => remove(recordPath(id)),
    async content(id, sha256) {
      const file = Bun.file(contentPath(id, sha256));
      return (await file.exists()) ? file : undefined;
    },
    writeSnapshot: (snapshot) => writeAtomic(snapshotPath, JSON.stringify(snapshot)),
    async appendReport(report) {
      const day = new Date(report.at).toISOString().slice(0, 10);
      await fs.appendFile(join(reports, `${day}.jsonl`), `${JSON.stringify(report)}\n`, {
        mode: FILE_MODE,
      });
    },
    async pruneReports(cutoff) {
      for (const name of await fs.readdir(reports)) {
        const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
        if (day !== undefined && Date.parse(`${day}T00:00:00Z`) < cutoff) {
          await remove(join(reports, name));
        }
      }
    },
    async freeBytes() {
      const stats = await fs.statfs(dir);
      return stats.bavail * stats.bsize;
    },
  };
}
