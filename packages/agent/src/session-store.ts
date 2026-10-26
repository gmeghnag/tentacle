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
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import type { ChatMessage } from "@tentacle/core";
import type { SessionSnapshot } from "./session.ts";

export interface SessionRecord {
  /** The session's stable uid (the `Session.id`, a random UUID). */
  readonly id: string;
  readonly cwd: string;
  readonly model: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  /**
   * The label for `--resume` lists: a string for the automatic title (the
   * first user message, trimmed — what every build reads), an object for a
   * chosen one (generated or renamed). An older build rejects the object form
   * loudly ("title" is not a string): a file with a chosen title is never
   * half-loaded and silently rewritten without it (docs/feat/session-titles.md).
   */
  readonly title: string | RecordTitle;
  readonly messages: readonly ChatMessage[];
}

/** A chosen title as a record stores it. */
export interface RecordTitle {
  readonly text: string;
  readonly source: "model" | "user";
}

/**
 * A session's title as its owner (the daemon) holds it: `auto` is derived from
 * the history (`sessionTitle`); `model` / `user` were chosen and are kept as is.
 */
export type TitleState =
  | { readonly source: "auto" }
  | { readonly source: "model" | "user"; readonly text: string };

/** Max length of a chosen title in a record (the wire's `MAX_SESSION_TITLE`). */
export const RECORD_TITLE_MAX = 256;

/** The title a record shows (`--resume` lists, the archive index). */
export function recordTitleText(record: Pick<SessionRecord, "title">): string {
  return typeof record.title === "string" ? record.title : record.title.text;
}

/** The record's title as a `TitleState` (a string is the derived, `auto` one). */
export function recordTitleState(record: Pick<SessionRecord, "title">): TitleState {
  return typeof record.title === "string"
    ? { source: "auto" }
    : { source: record.title.source, text: record.title.text };
}

/** The record form of `state`: `auto` → today's string (derived from `messages`), chosen → the object. */
export function encodeTitle(
  state: TitleState,
  messages: readonly ChatMessage[],
): string | RecordTitle {
  return state.source === "auto"
    ? sessionTitle(messages)
    : { text: state.text, source: state.source };
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

/**
 * Build a record from a session snapshot plus its metadata. `title`: the
 * daemon's title as last known (absent → `auto`, derived from the messages).
 */
export function recordFromSnapshot(
  snapshot: SessionSnapshot,
  meta: {
    readonly cwd: string;
    readonly model: string;
    readonly createdAt?: number;
    readonly title?: TitleState;
  },
): SessionRecord {
  const now = Date.now();
  return {
    id: snapshot.id,
    cwd: meta.cwd,
    model: meta.model,
    createdAt: meta.createdAt ?? now,
    updatedAt: now,
    title: encodeTitle(meta.title ?? { source: "auto" }, snapshot.messages),
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
/**
 * A directory name for the project at `cwd`: `<basename>-<sha256(realpath)[:12]>`.
 * The basename keeps it readable, the hash keeps distinct paths apart (and the
 * name short). A cwd that no longer exists falls back to its resolved path.
 */
export function projectKey(cwd: string): string {
  const absolute = resolve(cwd);
  let real = absolute;
  try {
    real = realpathSync(absolute);
  } catch {
    // Deleted (or unreadable) cwd: the resolved path still names it.
  }
  const hash = createHash("sha256").update(real).digest("hex").slice(0, 12);
  const base = basename(real)
    .replace(/[^A-Za-z0-9._-]/g, "_")
    .replace(/^\.+/, "");
  return `${base || "root"}-${hash}`;
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
// `durationMs` (docs/fix/tool-duration.md) followed `spill`'s path: an older
// build refuses a record holding one (`unknown key "durationMs"`), loudly.
// So did `contextUsage` (docs/feat/context-awareness.md).
const MESSAGE_KEYS = new Set([
  "role",
  "content",
  "toolCalls",
  "toolCallId",
  "spill",
  "durationMs",
  "contextUsage",
]);
const CONTEXT_USAGE_KEYS = new Set(["used", "window"]);
const TOOL_CALL_KEYS = ["id", "name", "arguments"];
// `spill` (docs/feat/tui-spill-note.md): an older build refuses a record that
// holds one (`unknown key "spill"`), loudly — never half-loaded.
const SPILL_KEYS = new Set(["chars", "path", "head", "tail", "omitted"]);
/** The wire's `ToolResultSpillSchema` path bound. */
const SPILL_PATH_MAX = 4096;

/** zod 3's `.int().nonnegative()`, exactly (the parity test). */
const isCount = (v: unknown): boolean => Number.isInteger(v) && (v as number) >= 0;

/** Exactly `chars`/`head`/`tail`/`omitted` (+ an optional non-empty `path`), each well-typed. */
function isSpill(value: unknown): boolean {
  return (
    isObject(value) &&
    Object.keys(value).every((key) => SPILL_KEYS.has(key)) &&
    isCount(value.chars) &&
    isCount(value.omitted) &&
    typeof value.head === "string" &&
    typeof value.tail === "string" &&
    (value.path === undefined ||
      (typeof value.path === "string" &&
        value.path.length > 0 &&
        value.path.length <= SPILL_PATH_MAX))
  );
}

/** Exactly `used` (a count) and `window` (a positive count): the wire's bounds. */
function isContextUsage(value: unknown): boolean {
  return (
    isObject(value) &&
    Object.keys(value).every((key) => CONTEXT_USAGE_KEYS.has(key)) &&
    isCount(value.used) &&
    isCount(value.window) &&
    (value.window as number) > 0
  );
}

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
  if (value.spill !== undefined && !isSpill(value.spill)) {
    return "has a malformed spill";
  }
  if (value.durationMs !== undefined && !isCount(value.durationMs)) {
    return "has a malformed durationMs";
  }
  if (value.contextUsage !== undefined && !isContextUsage(value.contextUsage)) {
    return "has a malformed contextUsage";
  }
  return null;
}

const TITLE_KEYS = new Set(["text", "source"]);

/** A string, or a chosen title with exactly `text` (non-empty, bounded) and `source` model|user. */
function titleProblem(title: unknown): string | null {
  if (typeof title === "string") {
    return null;
  }
  if (!isObject(title)) {
    return '"title" is not a string or a chosen title';
  }
  const extra = Object.keys(title).find((key) => !TITLE_KEYS.has(key));
  if (extra !== undefined) {
    return `"title" has unknown key "${extra}"`;
  }
  if (typeof title.text !== "string" || title.text === "" || title.text.length > RECORD_TITLE_MAX) {
    return '"title" has an invalid text';
  }
  if (title.source !== "model" && title.source !== "user") {
    return '"title" has an invalid source';
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
  for (const key of ["cwd", "model"]) {
    if (typeof value[key] !== "string") {
      return { ok: false, reason: `"${key}" is not a string` };
    }
  }
  const titleIssue = titleProblem(value.title);
  if (titleIssue) {
    return { ok: false, reason: titleIssue };
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

/** A queued deletion: in the same per-uid queue as saves, so the latest operation wins. */
const REMOVE = Symbol("remove");

/** One uid's write queue: at most one write running, at most one operation waiting. */
interface WriteSlot {
  queued: SessionRecord | typeof REMOVE | null;
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
    return this.enqueue(record.id, record);
  }

  /** Queue `op` for `id` (replacing a queued one) and start the pump if idle. */
  private enqueue(id: string, op: SessionRecord | typeof REMOVE): Promise<void> {
    let slot = this.slots.get(id);
    if (!slot) {
      slot = { queued: null, waiters: [], running: null };
      this.slots.set(id, slot);
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    slot.queued = op;
    slot.waiters.push({ resolve, reject });
    if (!slot.running) {
      slot.running = this.pump(id, slot);
    }
    return promise;
  }

  /** Run queued operations until the slot is empty; never rejects. */
  private async pump(id: string, slot: WriteSlot): Promise<void> {
    while (slot.queued) {
      const op = slot.queued;
      const waiters = slot.waiters;
      slot.queued = null;
      slot.waiters = [];
      try {
        await (op === REMOVE ? this.removeFile(id) : this.writeAtomic(op));
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

  /**
   * Delete a session file, in the uid's queue like a save, so the LATEST
   * operation wins: a save queued before it is superseded (its callers resolve
   * with the removal), a save already running finishes first and is then
   * deleted, and a save made after it writes the file again. An absent file is
   * a success; any other failure rejects.
   */
  async remove(id: string): Promise<void> {
    if (!SAFE_ID.test(id)) {
      throw new Error(`invalid session id ${JSON.stringify(id)}`);
    }
    return this.enqueue(id, REMOVE);
  }

  private async removeFile(id: string): Promise<void> {
    const target = this.file(id);
    try {
      await rm(target, { force: true });
    } catch (error) {
      throw new Error(`couldn't remove ${target}: ${describeFsError(error)}`, { cause: error });
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
   * Every `<uid>.json` file, loaded ONE AT A TIME in directory order (a caller
   * that keeps only what it needs holds one record at a time, however many
   * there are). A file gone since the directory read yields `absent`. A missing
   * directory yields nothing. Sweeps crash leftovers first, like `list`.
   */
  async *scan(): AsyncIterable<{ readonly id: string; readonly result: LoadResult }> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch {
      return;
    }
    await this.sweepTemps();
    for (const name of names) {
      if (!name.endsWith(".json")) {
        continue;
      }
      const id = name.slice(0, -".json".length);
      yield { id, result: await this.load(id) };
    }
  }

  /**
   * All valid sessions, newest-updated first, plus the files that could not be
   * used (reported, never silently dropped). A missing directory → empty.
   * Also sweeps temp files left by a crashed write (best-effort, see `sweepTemps`).
   */
  async list(): Promise<ListResult> {
    const records: SessionRecord[] = [];
    const skipped: SkippedSession[] = [];
    for await (const { id, result } of this.scan()) {
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
