/**
 * `tentacle connect --resume [id] | --continue` (docs/feat/connect-sessions.md):
 * which daemon session the first view attaches to, decided from the flags and
 * the daemon's own `session/list` — never from the laptop's store (`connect`
 * keeps no laptop copy, AGENTS §7 "Persistence"). Pure: the caller fetches the
 * list (only when `needsList` says so), runs the picker, and opens.
 *
 * Mirrors the local `--resume` (`session-resume.ts`): an id → that session (an
 * explicit reopen, so an archived one comes back); `--continue`, or `--resume`
 * without a terminal → the newest; `--resume` on a terminal with two or more →
 * the picker. Never a silent new session when the list fails.
 */
import {
  DomainErrorCode,
  JsonRpcErrorCode,
  type SessionListEntry,
  type SessionListResult,
} from "@tentacle/protocol";
import { type SessionChoice, oneLine } from "@tentacle/tui";

export interface ConnectResumeRequest {
  /** `--resume <id>` / `--resume=<id>`: the session named. */
  readonly id?: string;
  /** `--resume` with no id. */
  readonly resume: boolean;
  /** `--continue`. */
  readonly latest: boolean;
  /** A terminal can show the picker. */
  readonly tty: boolean;
}

export type ConnectResumePlan =
  | { readonly kind: "new"; readonly line?: string }
  | { readonly kind: "open"; readonly id: string; readonly reopen: boolean; readonly line?: string }
  | { readonly kind: "pick"; readonly choices: readonly SessionChoice[] }
  | { readonly kind: "error"; readonly message: string };

/** The first `session/list` page, or why it could not be read. */
export type ListOutcome =
  | { readonly ok: true; readonly result: SessionListResult }
  | { readonly ok: false; readonly error: unknown };

/** The daemon id as shown: one line, its first 8 characters (the full id stays the opaque key). */
export const shortId = (id: string): string => oneLine(id).slice(0, 8);

/** Whether the plan needs the daemon's list (an explicit id does not). */
export function needsList(request: ConnectResumeRequest): boolean {
  return request.id === undefined && (request.resume || request.latest);
}

export function planConnectResume(
  request: ConnectResumeRequest,
  list?: ListOutcome,
): ConnectResumePlan {
  if (request.id !== undefined) {
    // The person named it: an explicit reopen (ignored by a live session).
    return { kind: "open", id: request.id, reopen: true };
  }
  if (!request.resume && !request.latest) {
    return { kind: "new" };
  }
  if (!list) {
    return { kind: "error", message: "internal: the session list was not read" };
  }
  if (!list.ok) {
    return { kind: "error", message: listError(list.error) };
  }
  const sessions = list.result.sessions;
  const newest = sessions[0];
  if (!newest) {
    return { kind: "new", line: "[resume] no session on this daemon; starting a new one" };
  }
  if (request.resume && request.tty && sessions.length >= 2) {
    return { kind: "pick", choices: sessions.map(toChoice) };
  }
  return openEntry(newest);
}

/** The picker's answer, on the list it was given. */
export function planPicked(list: SessionListResult, id: string): ConnectResumePlan {
  const entry = list.sessions.find((s) => s.sessionId === id);
  return entry
    ? openEntry(entry)
    : { kind: "error", message: `the picker returned an unknown session "${shortId(id)}"` };
}

/** Why a `session/open` of a resumed id failed, said plainly (decided by CODE). */
export function openError(id: string, error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  // Archived (only without reopen), deleted, never existed.
  if (
    code === DomainErrorCode.SessionArchived ||
    code === DomainErrorCode.SessionDeleted ||
    code === DomainErrorCode.UnknownSession
  ) {
    return `no session ${shortId(id)} on this daemon (ended, deleted, or never created)`;
  }
  return `could not open session ${shortId(id)}: ${oneLine(message)}`;
}

function openEntry(entry: SessionListEntry): ConnectResumePlan {
  return {
    kind: "open",
    id: entry.sessionId,
    reopen: entry.archived,
    line: `[resume] ${shortId(entry.sessionId)} — ${oneLine(entry.title)}`,
  };
}

function toChoice(entry: SessionListEntry): SessionChoice {
  return {
    id: entry.sessionId,
    title: oneLine(entry.title),
    updatedAt: entry.updatedAt,
    running: entry.running,
    attached: entry.attached,
    archived: entry.archived,
  };
}

function listError(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === JsonRpcErrorCode.MethodNotFound) {
    return "this daemon cannot list sessions (no session/list) — update tentacle on the daemon, or pass --resume <id>";
  }
  const message = error instanceof Error ? error.message : String(error);
  return `could not list the daemon's sessions: ${oneLine(message)}`;
}
