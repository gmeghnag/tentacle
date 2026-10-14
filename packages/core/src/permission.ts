/**
 * Permission contract.
 *
 * Tools declare a `PermissionLevel` (see `tool.ts`); an `"ask"` tool must be
 * authorized before it runs. The authorization is produced by a
 * `PermissionRequester` — in the interactive TUI that is a prompt to the user;
 * headless callers use `allowAll`/`denyAll`.
 *
 * `PermissionBroker` lets the requester be swapped at runtime: the agent is wired
 * to the broker up front, and the TUI attaches its interactive requester once it
 * has mounted (restoring the default on unmount).
 */
import type { PermissionLevel } from "./tool.ts";

export interface PermissionRequest {
  readonly tool: string;
  readonly level: PermissionLevel;
  /** Human-readable action, e.g. "Run a shell command". */
  readonly title: string;
  /** The concrete subject, e.g. the command or file path. */
  readonly detail?: string;
  /** The validated (or best-effort parsed) tool input. */
  readonly input: unknown;
  /**
   * A narrower "don't ask again" rule a session-scoped approval should create,
   * instead of whitelisting the whole tool. For shell this is a command prefix
   * (e.g. `git commit`) — only matching future commands auto-run.
   */
  readonly suggestion?: PermissionSuggestion;
}

export interface PermissionSuggestion {
  /** A shell command prefix, e.g. `npm run` — future commands with it auto-run. */
  readonly prefix: string;
}

/** How long an approval lasts. `session` is remembered; `once` is not. */
export type PermissionScope = "once" | "session";

export interface PermissionResponse {
  readonly allowed: boolean;
  readonly scope?: PermissionScope;
}

export type PermissionRequester = (req: PermissionRequest) => Promise<PermissionResponse>;

/** Approve everything (headless default: the caller launched the run). */
export const allowAll: PermissionRequester = async () => ({ allowed: true });

/** Refuse everything that needs approval. */
export const denyAll: PermissionRequester = async () => ({ allowed: false });

export class PermissionBroker {
  private requester: PermissionRequester;

  constructor(initial: PermissionRequester = allowAll) {
    this.requester = initial;
  }

  setRequester(requester: PermissionRequester): void {
    this.requester = requester;
  }

  reset(): void {
    this.requester = allowAll;
  }

  request(req: PermissionRequest): Promise<PermissionResponse> {
    return this.requester(req);
  }
}
