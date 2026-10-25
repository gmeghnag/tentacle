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
 * has mounted (restoring the default on unmount). On the RPC path the broker is
 * built with `holdUntilSet`, so "no requester yet" queues instead of approving.
 */
import type { PermissionLevel } from "./tool.ts";

export interface PermissionRequest {
  /**
   * What is asked (laptop-internal, never on the wire): a tool call (absent =
   * `"tool"`) or whether to trust a project's hooks (`"hooks_trust"`,
   * docs/feat/hooks-project-trust.md) — which auto-approve never answers.
   */
  readonly kind?: "tool" | "hooks_trust";
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
  /**
   * No human decision was made: the prompt was withdrawn (its signal aborted)
   * or torn down (the TUI unmounted). A gate treats it as `allowed: false`; an
   * RPC client sends NOTHING for it — the request stays pending daemon-side.
   */
  readonly dismissed?: true;
  /**
   * No human could be asked, and why (e.g. the client cannot show a
   * permission request): a refusal the model is told about, never a decision
   * the user made (docs/feat/protocol-v10-forward-compat.md).
   */
  readonly reason?: string;
}

export interface PermissionRequestOptions {
  /** Aborted when the request is withdrawn (answered elsewhere, its turn cancelled). */
  readonly signal?: AbortSignal;
  /**
   * The remote turn the request was raised in, by the stream's brackets
   * (laptop-internal, never on the wire, like `signal`). A frontend tells its
   * own turns from another device's with it (auto-accept answers only its
   * own: docs/feat/tui-foreign-turns.md). Absent: a local request.
   */
  readonly turnId?: string;
}

export type PermissionRequester = (
  req: PermissionRequest,
  options?: PermissionRequestOptions,
) => Promise<PermissionResponse>;

/** Approve everything (headless default: the caller launched the run). */
export const allowAll: PermissionRequester = async () => ({ allowed: true });

/** Refuse everything that needs approval. */
export const denyAll: PermissionRequester = async () => ({ allowed: false });

/** What a withdrawn prompt resolves to. */
export const DISMISSED: PermissionResponse = { allowed: false, dismissed: true };

export interface PermissionBrokerOptions {
  /**
   * While no requester is set (before the first `setRequester`, or after
   * `reset()`), QUEUE requests instead of approving them with `allowAll`; the
   * next `setRequester` receives them in order. For every broker on the RPC
   * path: a daemon's request can arrive before the TUI has mounted its prompt,
   * and approving it there would be the silent auto-approve AGENTS §7 warns of.
   */
  readonly holdUntilSet?: boolean;
}

interface Held {
  readonly req: PermissionRequest;
  readonly options: PermissionRequestOptions | undefined;
  readonly resolve: (response: PermissionResponse) => void;
  readonly reject: (error: unknown) => void;
  readonly detach: () => void;
}

export class PermissionBroker {
  private requester: PermissionRequester | null;
  private readonly holdUntilSet: boolean;
  private held: Held[] = [];

  constructor(initial?: PermissionRequester, options: PermissionBrokerOptions = {}) {
    this.holdUntilSet = options.holdUntilSet === true;
    this.requester = initial ?? (this.holdUntilSet ? null : allowAll);
  }

  setRequester(requester: PermissionRequester): void {
    this.requester = requester;
    const held = this.held;
    this.held = [];
    for (const entry of held) {
      entry.detach();
      requester(entry.req, entry.options).then(entry.resolve, entry.reject);
    }
  }

  reset(): void {
    this.requester = this.holdUntilSet ? null : allowAll;
  }

  request(req: PermissionRequest, options?: PermissionRequestOptions): Promise<PermissionResponse> {
    if (this.requester) {
      return this.requester(req, options);
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.resolve(DISMISSED);
    }
    return new Promise((resolve, reject) => {
      const onAbort = (): void => {
        this.held = this.held.filter((h) => h !== entry);
        resolve(DISMISSED);
      };
      const entry: Held = {
        req,
        options,
        resolve,
        reject,
        detach: () => signal?.removeEventListener("abort", onAbort),
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.held.push(entry);
    });
  }
}
