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
import { PermissionReplyTextSchema } from "@tentacle/protocol";
import type { PermissionLevel } from "./tool.ts";

/**
 * A valid reply text (docs/feat/permission-reply.md), by the wire's own
 * `PermissionReplyTextSchema` — the one source of its bounds, so a store that
 * mirrors the wire (the laptop's session store) never restates them.
 */
export function isPermissionReplyText(value: unknown): value is string {
  return PermissionReplyTextSchema.safeParse(value).success;
}

/**
 * The wire `tool` of a `workflow_approve` ask (docs/feat/agent-workflows.md D2/D3):
 * the daemon raises it, the client maps it back to `kind: "workflow_approve"`.
 */
export const WORKFLOW_APPROVE_TOOL = "workflow_approve";

export interface PermissionRequest {
  /**
   * What is asked (laptop-internal, never on the wire): a tool call (absent =
   * `"tool"`), whether to trust a project's hooks (`"hooks_trust"`,
   * docs/feat/hooks-project-trust.md) — or whether to move this session to
   * another target (`"session_hop"`, docs/feat/session-hop.md D6/D9). A
   * `hooks_trust` is never answered by auto-accept. A `session_hop` is answered
   * ONLY when `hopAuto` is set (docs/feat/session-hop-ux OD4). A
   * `workflow_approve` (a workflow's hash approval, or its `approve` step —
   * docs/feat/agent-workflows.md D2/D3) is NEVER answered by auto-accept.
   */
  readonly kind?: "tool" | "hooks_trust" | "session_hop" | "workflow_approve";
  /**
   * Slack (laptop-internal, never on the wire): this `session_hop` is one
   * auto-accept MAY answer, because the LAPTOP's own rule said so
   * (`hopAutoAcceptable`: anything but a move toward local proposed from a
   * workload). Set by `hopPromptRequest` and by nothing else — the mount gate's
   * `ask` (`mountAsk`) never sets it, so a typed hop still asks.
   *
   * It is the whole reason the single-broker invariant carries this feature: a
   * daemon cannot set it (`toPermissionRequest` rebuilds a request from an
   * allowlist), so whether a pod-originated move is waved through is decided by
   * facts only the laptop holds (AGENTS §7, "a pod is not trusted").
   */
  readonly hopAuto?: true;
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
  /**
   * The asker takes a reply with a refusal, up to `maxChars` (a daemon's
   * `permission_request.reply`, docs/feat/permission-reply.md). Absent: a
   * refusal carries no `message` — a frontend does not offer one.
   */
  readonly reply?: { readonly maxChars: number };
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
  /**
   * The person's reply with a refusal (only with `allowed: false`, only for a
   * request with `reply`): the model gets it with the denial
   * (docs/feat/permission-reply.md). Ignored on an approval.
   */
  readonly message?: string;
  /**
   * Set by a requester whose answer carries `message` (process-internal,
   * never on the wire): the runtime calls it once if that answer did NOT
   * reach the asker (settled elsewhere first, the session lost, a failed
   * send) — so the person's words are handed back, never lost silently.
   * `cause` says why, so the person is told the truth (`AnswerLostCause`).
   */
  readonly onAnswerLost?: (cause: AnswerLostCause) => void;
  /**
   * Answered by AUTO-ACCEPT, not by a human (process-internal, never on the wire):
   * no prompt was shown, so the outcome line must say so — that is OD4's "logged
   * allow-once". Only the TUI's own requester sets it
   * (`permission-ui.ts`), and only on the branch that skipped the dialog.
   */
  readonly auto?: true;
}

/**
 * Why an answer with a reply did not reach the asker:
 * - `settled`: the request was no longer pending (answered elsewhere, or
 *   withdrawn) — the agent got another answer, not this one;
 * - `unreplyable`: the asker takes no reply (an older daemon) — nothing sent;
 * - `session-lost`: the session was lost mid-send — it MAY have arrived;
 * - `failed`: the send failed — not delivered.
 */
export type AnswerLostCause = "settled" | "unreplyable" | "session-lost" | "failed";

export interface PermissionRequestOptions {
  /** Aborted when the request is withdrawn (answered elsewhere, its turn cancelled). */
  readonly signal?: AbortSignal;
  /**
   * Aborted when the ASKER withdraws the prompt itself, to ask it again
   * (docs/feat/subagent-detach.md: a foreground child's open ask is withdrawn
   * and re-asked as `sa-N` when the child moves to the background). It settles
   * the request like `signal` does, but the difference matters to the asker:
   * a `cancelled` outcome caused by THIS one is `dismissed`, never a decision.
   * Process-internal, like `signal`: never on the wire.
   */
  readonly withdraw?: AbortSignal;
  /**
   * The OTHER devices this ask was also raised to, by their declared labels
   * (`ClientInfo.host`, docs/feat/session-auto-accept.md D7). Display only —
   * nothing decides on it — and it still names THIS device: a surface drops its
   * own label (see `otherDevicesAsked`). Absent: the daemon named nobody.
   */
  readonly askedOn?: readonly string[];
  /**
   * The remote turn the request was raised in, by the stream's brackets
   * (laptop-internal, never on the wire, like `signal`). A frontend tells its
   * own turns from another device's with it (auto-accept answers only its
   * own: docs/feat/tui-foreign-turns.md). Absent: a local request.
   */
  readonly turnId?: string;
  /**
   * The call the ask is for: the asking call itself, or the parent
   * `agent_task` call of a sub-agent (process-internal, like `signal`; the
   * daemon projects it onto the wire's `toolCallId`).
   */
  readonly toolCallId?: string;
  /** `call`: the call asked for itself. `subagent`: a sub-agent inside call `toolCallId` asked. */
  readonly origin?: "call" | "subagent";
  /**
   * The first call of the asking call's group: the calls authorized together
   * and then run together (docs/feat/round-groups-persistence.md). A call
   * alone is its own group. Absent: the call itself. Process-internal.
   */
  readonly groupStart?: string;
  /** Which sub-agent asked (display only; set with `origin: "subagent"`). */
  readonly agent?: { readonly type: string; readonly description: string; readonly id?: string };
  /**
   * The workflow step (or run / schedule approval) the ask belongs to
   * (display only; `index` 0-based of `count` steps).
   */
  readonly workflow?: {
    readonly name: string;
    readonly runId?: string;
    readonly stepId?: string;
    readonly index?: number;
    readonly count?: number;
  };
  /**
   * The daemon's id for this ask (process-internal, never on the wire — the
   * requester is handed it with the update it came from). A surface that
   * carries the prompt across a navigation uses it to tell one ask from the
   * next (mobile: the sheet's route param, docs/feat/mobile-native-sheets.md).
   * Absent: the requester did not say (a local request).
   */
  readonly requestId?: string;
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

/**
 * `AbortSignal.any` (Bun has it; the repo's TS lib does not declare it):
 * one signal that aborts when ANY of them does.
 */
export const anySignal = (signals: AbortSignal[]): AbortSignal =>
  (AbortSignal as unknown as { any(signals: AbortSignal[]): AbortSignal }).any(signals);

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

  /**
   * Withdraw the requester. With `only`, withdraw ONLY that requester: a caller
   * whose release arrives late (a screen whose `session/detach` settled after a
   * NEWER screen mounted its own) must not clear the one that replaced it —
   * that is the "single broker" invariant's silent failure (every ask is held,
   * no prompt, the turn hangs). With no argument: unconditional, as the single
   * TUI prompt's unmount needs.
   */
  reset(only?: PermissionRequester): void {
    if (only !== undefined && this.requester !== only) {
      return;
    }
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

/**
 * Whether auto-accept may answer `req` (docs/feat/session-auto-accept.md D4).
 * Lives HERE, in `@tentacle/core`, because every surface that decides shares
 * it and they cannot share a UI: a terminal (`@tentacle/tui`), the phone
 * (`apps/mobile`, React 19 vs the TUI's 18, AGENTS §6) and the detached run's
 * relay (`@tentacle/cli`) must answer with ONE rule, or a switch would grant
 * more on one device than another.
 *
 * Never a project-hooks trust request (docs/feat/hooks-project-trust.md):
 * trusting a repo's code is a human decision, not a tool call to wave through.
 * Never a request of a turn that is not `own` — another device's turn, or (on
 * a trusted daemon) the session's own wake turn, which the session's widest
 * test accepts (docs/fix/autoaccept-wake-turns.md).
 *
 * A session-hop request: ONLY when the laptop's own rule marked it `hopAuto`
 * (docs/feat/session-hop-ux OD4, which supersedes session-hop D9). The marker is
 * set by `hopPromptRequest` from `hopAutoAcceptable` — never by a daemon (the
 * wire mapping `toPermissionRequest` never yields it, so the phone and the
 * relay can never see it set), and never for the mount gate's own `ask` — so
 * the ONE exception (a move TOWARD LOCAL proposed from a pod/container,
 * AGENTS §7) still reaches a human.
 */
export function autoApproves(req: PermissionRequest, own = true): boolean {
  return (
    own &&
    req.kind !== "hooks_trust" &&
    // A workflow's hash approval authorises a whole sequence, and its approve
    // step is a merge/push: a human decision (docs/feat/agent-workflows.md D3).
    req.kind !== "workflow_approve" &&
    (req.kind !== "session_hop" || req.hopAuto === true)
  );
}

/**
 * Is a request of MY turn? `owns`: the session's own-vs-foreign test, absent
 * when no session decides (a local one: every request is mine). Under a
 * session that decides, a request with no turn is not known to be mine.
 *
 * Feed it the WIDEST test the session offers — `autoAcceptTest` picks
 * `autoAcceptsTurn` over `ownsTurn` when both exist
 * (docs/fix/autoaccept-wake-turns.md A5).
 */
export function ownRequest(
  turnId: string | undefined,
  owns: ((turnId: string) => boolean) | undefined,
): boolean {
  if (!owns) {
    return true;
  }
  return turnId !== undefined && owns(turnId);
}

/**
 * The OTHER devices an ask was also raised to ("Also asked on <computer>",
 * docs/feat/session-auto-accept.md D7): the daemon's `askedOn` with ONE copy of
 * this device's own label removed — a surface says what its siblings are asked,
 * never what it is itself. `own`: this device's own `ClientInfo.host`, absent
 * when it did not name itself (a pod-side client), and then nothing is dropped.
 * Display only, and still untrusted text: the caller bounds and sanitizes each
 * label before it shows one.
 */
export function otherDevicesAsked(
  askedOn: readonly string[] | undefined,
  own: string | undefined,
): readonly string[] {
  if (askedOn === undefined) {
    return [];
  }
  if (own === undefined) {
    return askedOn;
  }
  let dropped = false;
  return askedOn.filter((label) => {
    if (!dropped && label === own) {
      dropped = true;
      return false;
    }
    return true;
  });
}
