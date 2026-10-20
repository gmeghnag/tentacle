/**
 * Durable sessions as plain JSON files — one `<uid>.json` per conversation in a
 * directory, so `--resume` can pick one back up (and the latest by default).
 *
 * Deliberately a file store, not a database: a session is just its message
 * history plus a little metadata; a human can read, diff, or delete the files.
 *
 * Durability: a save writes a temp file in the same directory, fsyncs it and
 * renames it over `<uid>.json`, so a crash at any instant leaves the old file
 * or the new one, never half of one. Saves of one uid are serialized (latest
 * wins). Reads validate the shape and report a bad file instead of treating
 * it as absent.
 */
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
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

/** Why a session file could not be used — a corrupt file is not an absent one. */
export type LoadResult =
  | { readonly status: "ok"; readonly record: SessionRecord }
  | { readonly status: "absent" }
  | { readonly status: "unreadable"; readonly file: string; readonly reason: string };

/** A session file `list()` could not use, with the reason. */
export interface SkippedSession {
  readonly id: string;
  readonly file: string;
  readonly reason: string;
}

export interface ListResult {
  /** Valid sessions, newest-updated first. */
  readonly records: SessionRecord[];
  readonly skipped: SkippedSession[];
}

/** The filesystem writes the store does; injectable so tests can interrupt one. */
export interface SessionStoreIo {
  /** Write `data` to a NEW file at `path` and make it durable (fsync) before resolving. */
  writeDurable(path: string, data: string): Promise<void>;
}

const defaultIo: SessionStoreIo = {
  async writeDurable(path, data) {
    const handle = await open(path, "w", 0o600);
    try {
      await handle.writeFile(data);
      await handle.sync();
    } finally {
      await handle.close();
    }
  },
};

/** A uid usable as a file stem: no separators, no leading dot (`--resume ../x`). */
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Whether `id` can name a session file (no path separators, no leading dot). */
export function isValidSessionId(id: string): boolean {
  return SAFE_ID.test(id);
}
/** A temp this old is a leftover even if its pid is alive again (pid reuse). */
const STALE_TEMP_MS = 60 * 60 * 1000;
/** `.<uid>.json.tmp-<pid>-<rand>`: the writer's pid tells a leftover from a write in flight. */
const TEMP_NAME = /^\..+\.json\.tmp-(\d+)-[0-9a-f]+$/;
const FS_ERRORS: Record<string, string> = {
  EACCES: "permission denied",
  EPERM: "operation not permitted",
  ENOSPC: "no space left on device",
  EDQUOT: "disk quota exceeded",
  EROFS: "read-only file system",
  EIO: "I/O error",
};

/** A filesystem error without the (hidden temp) path it was raised on. */
function describeFsError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (typeof code === "string") {
    return `${FS_ERRORS[code] ?? "error"} (${code})`;
  }
  return error instanceof Error ? error.message : String(error);
}

/** Whether process `pid` exists (EPERM: it does, owned by someone else). */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: unknown }).code === "EPERM";
  }
}
const ROLES = new Set(["system", "user", "assistant", "tool"]);
// Mirrors the strict wire `ChatMessageSchema` (`@tentacle/protocol`, session.ts):
// a record that passes here can always seed `session/open`. Pinned by a cli test.
const MESSAGE_KEYS = new Set(["role", "content", "toolCalls", "toolCallId"]);
const TOOL_CALL_KEYS = ["id", "name", "arguments"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function messageProblem(value: unknown): string | null {
  if (!isObject(value)) {
    return "is not an object";
  }
  const extra = Object.keys(value).find((key) => !MESSAGE_KEYS.has(key));
  if (extra !== undefined) {
    return `has unknown key "${extra}"`;
  }
  if (typeof value.role !== "string" || !ROLES.has(value.role)) {
    return "has an invalid role";
  }
  if (typeof value.content !== "string") {
    return "has non-string content";
  }
  if (value.toolCallId !== undefined && typeof value.toolCallId !== "string") {
    return "has a non-string toolCallId";
  }
  if (value.toolCalls !== undefined) {
    const calls = value.toolCalls;
    const valid =
      Array.isArray(calls) &&
      calls.every(
        (call) =>
          isObject(call) &&
          Object.keys(call).length === TOOL_CALL_KEYS.length &&
          TOOL_CALL_KEYS.every((key) => typeof call[key] === "string"),
      );
    if (!valid) {
      return "has malformed toolCalls";
    }
  }
  return null;
}

/**
 * Check that a parsed session file is a usable record for uid `id`. Extra
 * top-level fields are kept as-is (a record type may extend this one).
 */
export function parseSessionRecord(
  value: unknown,
  id: string,
):
  | { readonly ok: true; readonly record: SessionRecord }
  | { readonly ok: false; readonly reason: string } {
  if (!isObject(value)) {
    return { ok: false, reason: "not a session record (not a JSON object)" };
  }
  if (value.id !== id) {
    return { ok: false, reason: `id ${JSON.stringify(value.id)} does not match the file name` };
  }
  for (const key of ["cwd", "model", "title"]) {
    if (typeof value[key] !== "string") {
      return { ok: false, reason: `"${key}" is not a string` };
    }
  }
  for (const key of ["createdAt", "updatedAt"]) {
    if (typeof value[key] !== "number" || !Number.isFinite(value[key])) {
      return { ok: false, reason: `"${key}" is not a finite number` };
    }
  }
  if (!Array.isArray(value.messages)) {
    return { ok: false, reason: '"messages" is not an array' };
  }
  for (const [index, message] of value.messages.entries()) {
    const problem = messageProblem(message);
    if (problem) {
      return { ok: false, reason: `message ${index} ${problem}` };
    }
  }
  return { ok: true, record: value as unknown as SessionRecord };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** One uid's write queue: at most one write running, at most one record waiting. */
interface WriteSlot {
  queued: SessionRecord | null;
  /** Settles the callers of the queued record (shared by every save it superseded). */
  waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }>;
  running: Promise<void> | null;
}

/** A directory of `<uid>.json` session files. */
export class JsonSessionStore {
  private readonly slots = new Map<string, WriteSlot>();
  /** Crash leftovers are swept once per store, before its first write. */
  private swept = false;

  constructor(
    private readonly dir: string,
    private readonly io: SessionStoreIo = defaultIo,
  ) {}

  private file(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  /**
   * Write (or overwrite) a session file atomically, creating the directory if
   * needed. Saves of one uid are serialized and coalesced: while a write runs, a
   * newer record replaces any queued one. Resolves once this record — or a newer
   * one of the same uid — is durable; REJECTS if that write failed, so the caller
   * must handle the rejection (an unhandled one terminates the process).
   */
  save(record: SessionRecord): Promise<void> {
    let slot = this.slots.get(record.id);
    if (!slot) {
      slot = { queued: null, waiters: [], running: null };
      this.slots.set(record.id, slot);
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    slot.queued = record;
    slot.waiters.push({ resolve, reject });
    if (!slot.running) {
      slot.running = this.pump(record.id, slot);
    }
    return promise;
  }

  /** Write queued records until the slot is empty; never rejects. */
  private async pump(id: string, slot: WriteSlot): Promise<void> {
    while (slot.queued) {
      const record = slot.queued;
      const waiters = slot.waiters;
      slot.queued = null;
      slot.waiters = [];
      try {
        await this.writeAtomic(record);
        for (const waiter of waiters) {
          waiter.resolve();
        }
      } catch (error) {
        for (const waiter of waiters) {
          waiter.reject(error);
        }
      }
    }
    slot.running = null;
    this.slots.delete(id);
  }

  private async writeAtomic(record: SessionRecord): Promise<void> {
    if (!SAFE_ID.test(record.id)) {
      throw new Error(`invalid session id ${JSON.stringify(record.id)}`);
    }
    const target = this.file(record.id);
    const suffix = crypto.randomUUID().slice(0, 8);
    const temp = join(this.dir, `.${record.id}.json.tmp-${process.pid}-${suffix}`);
    try {
      await mkdir(this.dir, { recursive: true });
      if (!this.swept) {
        this.swept = true;
        await this.sweepTemps();
      }
      await this.io.writeDurable(temp, `${JSON.stringify(record, null, 2)}\n`);
      await rename(temp, target);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      // Name the file the user knows, not the hidden temp the error was raised on.
      throw new Error(`couldn't write ${target}: ${describeFsError(error)}`, { cause: error });
    }
  }

  /**
   * Remove temp files left by a crashed write: their writer is gone, or they are
   * older than any real write. A live writer's temp (another tentacle process
   * mid-save, or this one) is kept. Best-effort: never fails the caller.
   */
  private async sweepTemps(): Promise<void> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const pid = Number(TEMP_NAME.exec(name)?.[1]);
      if (!pid || pid === process.pid) {
        continue;
      }
      const path = join(this.dir, name);
      try {
        if (!processAlive(pid) || Date.now() - (await stat(path)).mtimeMs > STALE_TEMP_MS) {
          await rm(path, { force: true });
        }
      } catch {
        // A temp that vanished or can't be removed is not worth failing over.
      }
    }
  }

  /** Resolve once every in-flight and queued write has settled (for teardown). */
  async drain(): Promise<void> {
    for (;;) {
      const running = [...this.slots.values()].flatMap((slot) =>
        slot.running ? [slot.running] : [],
      );
      if (running.length === 0) {
        return;
      }
      await Promise.all(running);
    }
  }

  /** Load one session by uid: the record, `absent`, or `unreadable` with the reason. */
  async load(id: string): Promise<LoadResult> {
    const file = this.file(id);
    if (!SAFE_ID.test(id)) {
      return { status: "unreadable", file, reason: `invalid session id ${JSON.stringify(id)}` };
    }
    let text: string;
    try {
      const f = Bun.file(file);
      if (!(await f.exists())) {
        return { status: "absent" };
      }
      text = await f.text();
    } catch (error) {
      return { status: "unreadable", file, reason: errorMessage(error) };
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      return { status: "unreadable", file, reason: `invalid JSON (${errorMessage(error)})` };
    }
    const parsed = parseSessionRecord(value, id);
    return parsed.ok
      ? { status: "ok", record: parsed.record }
      : { status: "unreadable", file, reason: parsed.reason };
  }

  /**
   * All valid sessions, newest-updated first, plus the files that could not be
   * used (reported, never silently dropped). A missing directory → empty.
   * Also sweeps temp files left by a crashed write (best-effort, see `sweepTemps`).
   */
  async list(): Promise<ListResult> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return { records: [], skipped: [] };
    }
    await this.sweepTemps();
    const records: SessionRecord[] = [];
    const skipped: SkippedSession[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const id = name.slice(0, -".json".length);
      const result = await this.load(id);
      if (result.status === "ok") {
        records.push(result.record);
      } else if (result.status === "unreadable") {
        skipped.push({ id, file: result.file, reason: result.reason });
      }
    }
    records.sort((a, b) => b.updatedAt - a.updatedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { records, skipped };
  }

  /** The most-recently-updated valid session (or null), plus the skipped files. */
  async latest(): Promise<{
    readonly record: SessionRecord | null;
    readonly skipped: SkippedSession[];
  }> {
    const { records, skipped } = await this.list();
    return { record: records[0] ?? null, skipped };
  }
}
