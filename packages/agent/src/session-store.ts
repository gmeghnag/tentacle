/**
 * A session as a record: its message history plus a little metadata, the
 * title helpers, and the naming rules of session files (`isValidSessionId`,
 * `projectKey`). The stores themselves are typed event logs, `<uid>.jsonl`
 * (`LogSessionStore`, `@tentacle/daemon`: docs/feat/session-log-laptop-store.md
 * for the laptop, docs/feat/session-log-serve-store.md for `serve`).
 */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, resolve } from "node:path";
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
 *
 * An `auto` title may carry `text`: the name the conversation HAD, pinned. A
 * compaction (or a context reset) replaces the history's head, so deriving
 * again would name the session after the summary written in its place
 * (docs/fix/connect-functest-batch.md item C); the pinned text keeps the
 * session's own name until something chooses another. Absent → derive.
 */
export type TitleState =
  | { readonly source: "auto"; readonly text?: string }
  | { readonly source: "model" | "user"; readonly text: string };

/** Max length of a chosen title in a record (the wire's `MAX_SESSION_TITLE`). */
export const RECORD_TITLE_MAX = 256;

/** The title a record shows (`--resume` lists, the archive index). */
export function recordTitleText(record: Pick<SessionRecord, "title">): string {
  return typeof record.title === "string" ? record.title : record.title.text;
}

/**
 * The record's title as a `TitleState`. A plain string is a DERIVED title:
 * pinned to that text (an `auto` title carrying it), never re-derived — the
 * record's string already IS this session's name, and deriving it again from
 * the messages names it after a compaction's summary instead.
 * `recordTitleText` keeps reading that string as the name.
 */
export function recordTitleState(record: Pick<SessionRecord, "title">): TitleState {
  if (typeof record.title !== "string") {
    return { source: record.title.source, text: record.title.text };
  }
  // The sentinel is not a name: a session with no visible message yet derives
  // again at the next save (its first prompt must become its title).
  return record.title === EMPTY_TITLE ? { source: "auto" } : { source: "auto", text: record.title };
}

/** The record form of `state`: `auto` → its pinned text, else today's string (derived from `messages`); chosen → the object. */
export function encodeTitle(
  state: TitleState,
  messages: readonly ChatMessage[],
): string | RecordTitle {
  return state.source === "auto"
    ? (state.text ?? sessionTitle(messages))
    : { text: state.text, source: state.source };
}

const TITLE_MAX = 80;
/** What `sessionTitle` answers with when the history holds no message the person wrote. */
export const EMPTY_TITLE = "(empty)";

/** A short, single-line label for a session (its first user message). */
export function sessionTitle(messages: readonly ChatMessage[]): string {
  const firstUser = messages.find((m) => m.role === "user" && m.note === undefined);
  const text = (firstUser?.content ?? "").replace(/\s+/g, " ").trim();
  if (text === "") {
    return EMPTY_TITLE;
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
