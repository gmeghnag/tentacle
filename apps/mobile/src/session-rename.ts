/**
 * Renaming a session from the phone (docs/feat/mobile-session-info.md, Owner
 * decision 5): tapping the title in the chat header opens a text field, and what
 * the person typed goes through the EXISTING rename path — `session/rename`
 * (`packages/protocol/src/session.ts:1067-1095`), the one the TUI's `/rename` uses
 * (`RemoteSession.rename`, `remote-session.ts:535`). Then the daemon streams
 * `session_title` to every attached client, so the name is the same everywhere.
 *
 * Pure and React-free (AGENTS §7): the three decisions — is this a no-op, is it
 * unusable, what does a failure say — live here, so the sheet only draws them.
 */
import { JsonRpcErrorCode, MAX_SESSION_TITLE } from "@tentacle/protocol";
import { RpcError } from "@tentacle/transport";

/** The rename field's own state: what is typed, whether it is saving, and why not. */
export interface RenameState {
  readonly text: string;
  readonly saving: boolean;
  readonly error: string | null;
}

/** What a typed title means, before anything is sent. */
export type RenamePlan =
  /** Nothing to do: unchanged (or only whitespace more than it), or empty. */
  | { readonly kind: "noop" }
  /** A title the daemon would reject anyway, said here so nothing round-trips. */
  | { readonly kind: "invalid"; readonly reason: string }
  /** Send this (already one line). */
  | { readonly kind: "send"; readonly title: string };

/**
 * The daemon's own cap (`MAX_SESSION_TITLE`, `session.ts:459`), IMPORTED rather
 * than restated: a local 200 silently refused a title the daemon would have
 * accepted, and any future move of the daemon's number drifted the two apart
 * (Review round 1, LOW).
 */
export const MAX_TITLE_LENGTH = MAX_SESSION_TITLE;

/**
 * Decide what the field means. **Empty or unchanged is a no-op** (Owner decision
 * 5): the person opened the sheet, looked, and closed it — never a round trip that
 * rewrites the title's source to `user` for nothing.
 */
export function renamePlan(current: string, typed: string): RenamePlan {
  const title = typed.replace(/\s+/g, " ").trim();
  if (title === "") {
    return { kind: "noop" };
  }
  if (title === current.replace(/\s+/g, " ").trim()) {
    return { kind: "noop" };
  }
  if (title.length > MAX_TITLE_LENGTH) {
    return { kind: "invalid", reason: `Keep it under ${MAX_TITLE_LENGTH} characters.` };
  }
  return { kind: "send", title };
}

/**
 * What a failed rename says. An older daemon's `MethodNotFound` gets its own
 * sentence (`RemoteClient.rename` already rewords it), a dead link another, and
 * anything else keeps the daemon's own words.
 */
export function renameErrorText(error: unknown): string {
  if (error instanceof RpcError && error.code === JsonRpcErrorCode.MethodNotFound) {
    return "This computer's tentacle is too old to rename sessions.";
  }
  if (error instanceof Error) {
    return error.message === "" ? "Couldn't rename the session." : error.message;
  }
  return "Couldn't rename the session.";
}

/** The title the header shows after a successful rename (the daemon's answer). */
export function titleAfterRename(stored: string): string {
  return stored.replace(/\s+/g, " ").trim();
}
