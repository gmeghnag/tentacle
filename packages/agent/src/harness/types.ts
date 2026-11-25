/**
 * The harness adapter interface (docs/feat/subagent-harness-runners.md D1).
 *
 * Transport-agnostic: ONE interface hosts a local CLI process (Claude Code,
 * later Codex/Gemini — through a `CliCodec`, D2) and a remote network agent
 * (A2A, later — D10). The sub-agent seam talks only to this; it never sees
 * argv, stdin or HTTP. Types only — no runtime code.
 */

export interface HarnessCaps {
  /** Can ask US before acting (Claude: yes; A2A: no — it acts remotely). */
  readonly permissionAsks: boolean;
  /** Can pause for an answer mid-run (A2A INPUT_REQUIRED). */
  readonly inputRequired: boolean;
  /** Accepts more text while running. */
  readonly steer: boolean;
  /** Reports tokens (A2A: no). */
  readonly usage: boolean;
  /** Reports dollars (A2A: no). */
  readonly cost: boolean;
  /** Reports a plan window (Claude Max: yes). */
  readonly quota: boolean;
  /** Enforces a JSON schema (Claude `--json-schema`; A2A: unenforced data part). */
  readonly structuredResult: boolean;
  /** May run in our cwd/worktree (A2A: none). */
  readonly workspace: "local" | "none";
}

/** Identifies a run on its harness, enough to reattach / resume it. */
export interface HarnessHandle {
  readonly adapter: string;
  /** Claude: the claude `session_id`. A2A: the taskId. */
  readonly id: string;
  /** A2A: `{ contextId, cardUrl }`. */
  readonly extra?: Readonly<Record<string, string>>;
}

export interface HarnessProbe {
  readonly ok: boolean;
  readonly version?: string;
  /** Why it is not usable (not installed, too old, card unreachable). */
  readonly reason?: string;
}

export interface HarnessRunSpec {
  readonly prompt: string;
  /** `write` = a local process in a worktree; `remote` = the only mode a remote adapter accepts. */
  readonly mode: "write" | "remote";
  readonly cwd?: string;
  readonly tools?: readonly string[];
  /** Passed verbatim (shape-checked by the caller AND by the codec). */
  readonly model?: string;
  /** Ask the harness to return a result matching this JSON schema (D9). */
  readonly jsonSchema?: unknown;
  readonly runId: string;
}

/** What the host answers to an `ask`. */
export type HarnessDecision =
  /** `input` = the input the gate APPROVED (a hook may have rewritten it). */
  | { readonly allow: true; readonly input: unknown }
  | { readonly allow: false; readonly message: string };

export type HarnessAsk =
  | { readonly type: "permission"; readonly tool: string; readonly input: unknown }
  | { readonly type: "input"; readonly question: string }
  | { readonly type: "auth"; readonly explanation: string };

export type HarnessEndStatus = "completed" | "failed" | "cancelled" | "rejected" | "budget";

export type HarnessEvent =
  | {
      readonly kind: "started";
      readonly handle: HarnessHandle;
      readonly detail: {
        readonly tools?: readonly string[];
        readonly permissionMode?: string;
        readonly version?: string;
      };
    }
  /** A tool call / a status text → `subagent_tool`. */
  | { readonly kind: "progress"; readonly label: string }
  /** An INCREMENT, already deduped by the adapter (never a running total). */
  | { readonly kind: "usage"; readonly promptTokens: number; readonly completionTokens: number }
  | {
      readonly kind: "quota";
      readonly window: string;
      /** 0..1, when the harness says. */
      readonly utilization?: number;
      /** Epoch seconds. */
      readonly resetsAt?: number;
      readonly allowed: boolean;
    }
  | { readonly kind: "ask"; readonly askId: string; readonly ask: HarnessAsk }
  | {
      readonly kind: "output";
      readonly text?: string;
      /** The text replaces the artifact's text so far (A2A `append:false`). */
      readonly replace?: boolean;
      readonly data?: unknown;
      readonly file?: {
        readonly name?: string;
        readonly mediaType?: string;
        readonly bytes?: number;
      };
    }
  | { readonly kind: "disconnected"; readonly reason: string }
  | {
      readonly kind: "end";
      readonly status: HarnessEndStatus;
      readonly text?: string;
      readonly structured?: unknown;
      readonly costUsd?: number;
      readonly error?: string;
    };

export interface HarnessRun {
  /** Ends after exactly one `end`, or throws. */
  readonly events: AsyncIterable<HarnessEvent>;
  /** Reply to a permission / input ask. */
  answer(askId: string, decision: HarnessDecision): Promise<void>;
  /** Steer (only when `caps.steer`). */
  send(text: string): Promise<void>;
  /** Best effort: a remote cancel is not guaranteed. */
  cancel(): Promise<"confirmed" | "unconfirmed">;
}

export interface HarnessAdapter {
  /** Instance name: "claude-code", "a2a:acme-reviewer". */
  readonly id: string;
  /** Trust class (D5, D10). */
  readonly kind: "local-process" | "remote";
  readonly caps: HarnessCaps;
  probe(signal: AbortSignal): Promise<HarnessProbe>;
  start(spec: HarnessRunSpec, signal: AbortSignal): Promise<HarnessRun>;
  /** Remote only (D10). */
  reattach?(handle: HarnessHandle, signal: AbortSignal): Promise<HarnessRun>;
}

/**
 * The pure half of a local CLI harness (D2). One instance is ONE run (the
 * parser keeps per-run state, e.g. usage dedupe); a transport builds it with
 * the codec's factory. Everything here is strings in, strings out.
 */
export interface CliCodec {
  readonly id: string;
  /** Minimum CLI version, `major.minor.patch`. */
  readonly versionFloor: string;
  /** Arguments after the command. Throws on a spec this codec must refuse. */
  argv(spec: HarnessRunSpec): string[];
  /** One stdout line → events; `null` when the line is not parsable JSON. Unknown types → `[]`. */
  parse(line: string): HarnessEvent[] | null;
  /** The stdin line answering an ask. */
  answer(askId: string, decision: HarnessDecision): string;
  /** The stdin line asking the CLI to stop gracefully, if it has one. */
  interrupt(): string | undefined;
  /** The stdin line carrying user text (the first prompt AND a later steer). */
  userMessage(text: string): string;
}
