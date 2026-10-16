/**
 * Durable sessions as plain JSON files — one `<uid>.json` per conversation in a
 * directory, so `--resume` can pick one back up (and the latest by default).
 *
 * Deliberately a file store, not a database: a session is just its message
 * history plus a little metadata; a human can read, diff, or delete the files.
 */
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { ChatMessage } from "@tentacle/core";
import type { SessionSnapshot } from "./session.ts";

export interface SessionRecord {
  /** The session's stable uid (the `Session.id`, a random UUID). */
  readonly id: string;
  readonly cwd: string;
  readonly model: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** First user message, trimmed — a human-readable label for `--resume` lists. */
  readonly title: string;
  readonly messages: readonly ChatMessage[];
}

const TITLE_MAX = 80;

/** A short, single-line label for a session (its first user message). */
export function sessionTitle(messages: readonly ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user");
  const text = (firstUser?.content ?? "").replace(/\s+/g, " ").trim();
  if (text === "") {
    return "(empty)";
  }
  return text.length > TITLE_MAX ? `${text.slice(0, TITLE_MAX - 1)}…` : text;
}

/** Build a record from a session snapshot plus its metadata. */
export function recordFromSnapshot(
  snapshot: SessionSnapshot,
  meta: { readonly cwd: string; readonly model: string; readonly createdAt?: number },
): SessionRecord {
  const now = Date.now();
  return {
    id: snapshot.id,
    cwd: meta.cwd,
    model: meta.model,
    createdAt: meta.createdAt ?? now,
    updatedAt: now,
    title: sessionTitle(snapshot.messages),
    messages: snapshot.messages,
  };
}

/** A directory of `<uid>.json` session files. */
export class JsonSessionStore {
  constructor(private readonly dir: string) {}

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /** Write (or overwrite) a session file, creating the directory if needed. */
  async save(record: SessionRecord): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    await Bun.write(this.file(record.id), `${JSON.stringify(record, null, 2)}\n`);
  }

  /** Load one session by uid, or null if absent/unreadable. */
  async load(id: string): Promise<SessionRecord | null> {
    try {
      const f = Bun.file(this.file(id));
      if (!(await f.exists())) {
        return null;
      }
      return (await f.json()) as SessionRecord;
    } catch {
      return null;
    }
  }

  /** All sessions, newest-updated first; missing directory → empty list. */
  async list(): Promise<SessionRecord[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return [];
    }
    const records: SessionRecord[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const record = await this.load(name.slice(0, -".json".length));
      if (record) {
        records.push(record);
      }
    }
    return records.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** The most-recently-updated session, or null if none. */
  async latest(): Promise<SessionRecord | null> {
    return (await this.list())[0] ?? null;
  }
}
