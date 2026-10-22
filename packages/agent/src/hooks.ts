/**
 * User hooks (docs/feat/hooks-core.md): shell commands the user configures to
 * run on agent events, with a JSON input on stdin.
 *
 * The decisions are pure and unit-tested without processes (`hookMatches`,
 * `parse*Outcome`, `combineToolCallVotes`); `HookRunner` is the thin I/O shell
 * that runs each matching hook through the session's `ExecutionEnvironment`.
 * `tool_call` hooks are consulted by the `PermissionGate`; `tool_result` hooks
 * run as the `runResultHooks` pipeline stage.
 */
import type {
  ChatMessage,
  ExecResult,
  ExecutionEnvironment,
  HookEvent,
  HookSpec,
  ToolResult,
} from "@tentacle/core";
import type { ResultTransform } from "./result-pipeline.ts";

/** Hook stdout above this is a failure (a flooding hook must not fill memory/context). */
export const MAX_HOOK_STDOUT = 1024 * 1024;
const MAX_REASON = 2000;
/** A `turn_start` hook's `context` above this is clipped (it lands in every later request). */
export const MAX_HOOK_CONTEXT = 10_000;
const DEFAULT_TIMEOUT_S = 600;
const DEFAULT_REASON = "blocked by hook";
const DEFAULT_STOP_REASON = "stopped by hook";

type OnFailure = HookSpec["onFailure"];
/** What one hook process produced; `"timeout"`/`"error"` when it did not finish normally. */
export type HookProcessOutcome = ExecResult | "timeout" | "error";

export type ToolCallVote =
  | { readonly kind: "none"; readonly failure?: string }
  | { readonly kind: "allow" }
  | { readonly kind: "ask" }
  | { readonly kind: "deny"; readonly reason: string }
  | { readonly kind: "modify"; readonly input: unknown; readonly decision?: "allow" | "ask" };

export type ToolCallVerdict =
  | { readonly kind: "deny"; readonly reason: string; readonly hook: string }
  | {
      readonly kind: "gate";
      readonly input: unknown;
      readonly modified: boolean;
      readonly force: "allow" | "ask" | null;
      /** The last hook that rewrote the input (set when `modified`). */
      readonly hook?: string;
    };

export type ResultVote =
  | { readonly kind: "pass"; readonly failure?: string }
  | { readonly kind: "replace"; readonly content: string; readonly isError?: boolean };

/** A hook's display name: its `name`, else the basename of the first word of `command`. */
export function hookName(spec: HookSpec): string {
  if (spec.name !== undefined) {
    return spec.name;
  }
  const first = spec.command.trim().split(/\s+/)[0] ?? spec.command;
  const base = first
    .split("/")
    .filter((p) => p.length > 0)
    .pop();
  return base ?? first;
}

const PLAIN_MATCHER = /^[A-Za-z0-9_-]+(\|[A-Za-z0-9_-]+)*$/;

/** Does `spec` apply to this tool? No matcher or "*" → yes; `a|b` names → exact; else an unanchored RegExp. */
export function hookMatches(spec: HookSpec, toolName: string): boolean {
  const m = spec.matcher;
  if (m === undefined || m === "*") {
    return true;
  }
  if (PLAIN_MATCHER.test(m)) {
    return m.split("|").includes(toolName);
  }
  try {
    return new RegExp(m).test(toolName);
  } catch {
    // Validated at config load; an invalid one that slipped through matches nothing.
    return false;
  }
}

function isObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Classify a process outcome: `{ ok: json|null }` for exit 0 (null = empty
 * stdout), `{ exit2: stderr }`, or `{ failure: why }`.
 */
function classify(
  r: HookProcessOutcome,
): { ok: Record<string, unknown> | null } | { exit2: string } | { failure: string } {
  if (r === "timeout") {
    return { failure: "timed out" };
  }
  if (r === "error") {
    return { failure: "could not be started" };
  }
  if (r.exitCode === 2) {
    return { exit2: clip(r.stderr.trim(), MAX_REASON) };
  }
  if (r.exitCode !== 0) {
    const err = r.stderr.trim();
    return { failure: `exited ${r.exitCode}${err ? `: ${clip(err, 200)}` : ""}` };
  }
  if (r.stdout.length > MAX_HOOK_STDOUT) {
    return { failure: "output exceeds 1 MiB" };
  }
  const out = r.stdout.trim();
  if (out === "") {
    return { ok: null };
  }
  try {
    const parsed: unknown = JSON.parse(out);
    return isObject(parsed) ? { ok: parsed } : { failure: "output is not a JSON object" };
  } catch {
    return { failure: "output is not a JSON object" };
  }
}

/** Turn one `tool_call` hook's process outcome into a vote. */
export function parseToolCallOutcome(r: HookProcessOutcome, onFailure: OnFailure): ToolCallVote {
  const fail = (why: string): ToolCallVote =>
    onFailure === "block"
      ? { kind: "deny", reason: `hook failed: ${why}` }
      : { kind: "none", failure: why };
  const c = classify(r);
  if ("failure" in c) {
    return fail(c.failure);
  }
  if ("exit2" in c) {
    return { kind: "deny", reason: c.exit2 || DEFAULT_REASON };
  }
  if (c.ok === null) {
    return { kind: "none" };
  }
  const { decision, reason, input } = c.ok;
  if (decision !== undefined && decision !== "allow" && decision !== "ask" && decision !== "deny") {
    return fail(`unknown decision ${JSON.stringify(decision)}`);
  }
  if (decision === "deny") {
    const why = typeof reason === "string" ? clip(reason.trim(), MAX_REASON) : "";
    return { kind: "deny", reason: why || DEFAULT_REASON };
  }
  if (input !== undefined) {
    if (!isObject(input)) {
      return fail("`input` is not a JSON object");
    }
    return decision === undefined ? { kind: "modify", input } : { kind: "modify", input, decision };
  }
  return decision === undefined ? { kind: "none" } : { kind: decision };
}

/** Turn one `tool_result` hook's process outcome into a vote. */
export function parseToolResultOutcome(r: HookProcessOutcome, onFailure: OnFailure): ResultVote {
  const fail = (why: string): ResultVote =>
    onFailure === "block"
      ? { kind: "replace", content: `hook failed: ${why}`, isError: true }
      : { kind: "pass", failure: why };
  const c = classify(r);
  if ("failure" in c) {
    return fail(c.failure);
  }
  if ("exit2" in c) {
    return { kind: "replace", content: c.exit2, isError: true };
  }
  if (c.ok === null) {
    return { kind: "pass" };
  }
  const { content, is_error } = c.ok;
  if (content === undefined) {
    return { kind: "pass" };
  }
  if (typeof content !== "string") {
    return fail("`content` is not a string");
  }
  if (is_error !== undefined && typeof is_error !== "boolean") {
    return fail("`is_error` is not a boolean");
  }
  return is_error === undefined
    ? { kind: "replace", content }
    : { kind: "replace", content, isError: is_error };
}

export type TurnStartVote =
  | { readonly kind: "none"; readonly failure?: string }
  | { readonly kind: "context"; readonly text: string }
  | { readonly kind: "stop"; readonly reason: string };

export type TurnEndVote =
  | { readonly kind: "stop"; readonly failure?: string }
  | { readonly kind: "continue"; readonly reason: string };

/** Turn one `turn_start` hook's process outcome into a vote. */
export function parseTurnStartOutcome(r: HookProcessOutcome, onFailure: OnFailure): TurnStartVote {
  const fail = (why: string): TurnStartVote =>
    onFailure === "block"
      ? { kind: "stop", reason: `hook failed: ${why}` }
      : { kind: "none", failure: why };
  const c = classify(r);
  if ("failure" in c) {
    return fail(c.failure);
  }
  if ("exit2" in c) {
    return { kind: "stop", reason: c.exit2 || DEFAULT_STOP_REASON };
  }
  if (c.ok === null || c.ok.context === undefined) {
    return { kind: "none" };
  }
  if (typeof c.ok.context !== "string") {
    return fail("`context` is not a string");
  }
  return c.ok.context.trim() === ""
    ? { kind: "none" }
    : { kind: "context", text: clip(c.ok.context, MAX_HOOK_CONTEXT) };
}

/** Turn one `turn_end` (end_turn) hook's process outcome into a vote. */
export function parseTurnEndOutcome(r: HookProcessOutcome, onFailure: OnFailure): TurnEndVote {
  const fail = (why: string): TurnEndVote =>
    onFailure === "block"
      ? { kind: "continue", reason: `hook failed: ${why}` }
      : { kind: "stop", failure: why };
  const c = classify(r);
  if ("failure" in c) {
    return fail(c.failure);
  }
  if ("exit2" in c) {
    return { kind: "continue", reason: c.exit2 };
  }
  if (c.ok === null || c.ok.continue === undefined) {
    return { kind: "stop" };
  }
  if (typeof c.ok.continue !== "boolean") {
    return fail("`continue` is not a boolean");
  }
  if (!c.ok.continue) {
    return { kind: "stop" };
  }
  const reason = typeof c.ok.reason === "string" ? clip(c.ok.reason.trim(), MAX_REASON) : "";
  return { kind: "continue", reason };
}

/**
 * The messages a `model_request` hook has not seen yet: those after the
 * previous call's count — or all of them when there was none or the history
 * shrank since (a compaction).
 */
export function modelRequestDelta(
  messages: readonly ChatMessage[],
  lastCount: number | undefined,
): readonly ChatMessage[] {
  return lastCount === undefined || lastCount > messages.length
    ? messages
    : messages.slice(lastCount);
}

/** The user-role note a hook injects into the history. */
export function hookNote(event: HookEvent, text: string): string {
  return `[hook ${event}] ${text}`;
}

export interface NamedVote {
  readonly hook: string;
  readonly vote: ToolCallVote;
}

/**
 * Fold the votes of the matching hooks, in config order, over the model's
 * `input`: the first deny wins; `modify` chains the input; any `ask` forces a
 * prompt; `allow` forces a run only when EVERY matching hook allowed.
 */
export function combineToolCallVotes(input: unknown, votes: readonly NamedVote[]): ToolCallVerdict {
  let current = input;
  let modifiedBy: string | undefined;
  let anyAsk = false;
  let allAllow = votes.length > 0;
  for (const { hook, vote } of votes) {
    switch (vote.kind) {
      case "deny":
        return { kind: "deny", reason: vote.reason, hook };
      case "modify":
        current = vote.input;
        modifiedBy = hook;
        anyAsk ||= vote.decision === "ask";
        allAllow &&= vote.decision === "allow";
        break;
      case "ask":
        anyAsk = true;
        allAllow = false;
        break;
      case "allow":
        break;
      case "none":
        allAllow = false;
        break;
    }
  }
  const force = anyAsk ? "ask" : allAllow ? "allow" : null;
  return modifiedBy !== undefined
    ? { kind: "gate", input: current, modified: true, force, hook: modifiedBy }
    : { kind: "gate", input: current, modified: false, force };
}

/**
 * D6 (docs/feat/hooks-project-trust.md): a project hook may vote `allow` only
 * where it may approve (local); elsewhere (a pod) its `allow` is no vote and
 * a `modify` keeps its rewrite but loses its forced `allow`.
 */
export function projectVote(vote: ToolCallVote, canAllow: boolean): ToolCallVote {
  if (canAllow) {
    return vote;
  }
  if (vote.kind === "allow") {
    return { kind: "none" };
  }
  if (vote.kind === "modify" && vote.decision === "allow") {
    return { kind: "modify", input: vote.input };
  }
  return vote;
}

/** What the laptop is asked before a session runs the project's hooks (no `sessionId`). */
export interface ProjectHooksTrustRequest {
  readonly folder: string;
  readonly hash: string;
  readonly files: readonly string[];
  readonly hooks: readonly { event: string; matcher?: string; command: string }[];
  readonly canAllow: boolean;
}

/** Ask whether to trust the project hooks; `true` = run them this session. */
export type AskHooksTrust = (
  request: ProjectHooksTrustRequest & { readonly sessionId: string },
  signal?: AbortSignal,
) => Promise<boolean>;

/** The repo's `.agents/hooks.json` hooks, run only once trusted. */
export interface ProjectHooksOptions {
  readonly specs: readonly HookSpec[];
  readonly folder: string;
  readonly hash: string;
  readonly files: readonly string[];
  /** May a project hook `allow` here (local: yes; a pod: no, D6). */
  readonly canAllow: boolean;
}

/** Per-session trust of the project hooks, shared by a runner and its sub-agents' runners. */
export interface ProjectTrustState {
  state: "unknown" | "trusted" | "declined";
}

export interface HookAgentInfo {
  readonly type: string;
  readonly description: string;
}

export interface HookRunnerOptions {
  readonly specs: readonly HookSpec[];
  readonly env: ExecutionEnvironment;
  readonly cwd: string;
  /** Daemon-side log sink for hook failures (never the terminal while Ink owns it). */
  readonly log?: (line: string) => void;
  /** Set for a sub-agent's runner (H2). */
  readonly agent?: HookAgentInfo;
  /** The configured model id, reported to `model_request` hooks. */
  readonly modelId?: string;
  /**
   * Run `model_request` hooks — only when this process calls the provider
   * itself. In a pod the request is built in the untrusted pod (D2): false.
   */
  readonly modelRequestHooks?: boolean;
  /** Project hooks: run after the user's for the same event, and only once trusted. */
  readonly project?: ProjectHooksOptions;
  /** Shared with `forAgent` runners: one trust decision per session. */
  readonly projectTrust?: ProjectTrustState;
}

interface ToolEventInput {
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: unknown;
  readonly signal?: AbortSignal;
}

export class HookRunner {
  /** Per session: the history length at the last `model_request` sent. */
  private readonly modelRequestCounts = new Map<string, number>();
  /** Sessions with a `model_request` notification still running (R3). */
  private readonly modelRequestBusy = new Set<string>();
  /** Sessions whose current drop burst was already logged (R3). */
  private readonly modelRequestDropLogged = new Set<string>();

  private readonly opts: HookRunnerOptions;
  private readonly trust: ProjectTrustState;

  constructor(opts: HookRunnerOptions) {
    this.trust = opts.projectTrust ?? { state: "unknown" };
    this.opts = { ...opts, projectTrust: this.trust };
  }

  /** Project hooks exist and nobody decided on them yet this session. */
  needsProjectTrust(): boolean {
    return this.opts.project !== undefined && this.trust.state === "unknown";
  }

  /** What to ask the laptop (undefined when there are no project hooks). */
  projectTrustRequest(): ProjectHooksTrustRequest | undefined {
    const p = this.opts.project;
    if (p === undefined) {
      return undefined;
    }
    return {
      folder: p.folder,
      hash: p.hash,
      files: p.files,
      hooks: p.specs.map((s) =>
        s.matcher !== undefined
          ? { event: s.event, matcher: s.matcher, command: s.command }
          : { event: s.event, command: s.command },
      ),
      canAllow: p.canAllow,
    };
  }

  /**
   * Decide on the project hooks once per session (before the first fresh
   * turn's hooks run): ask through `ask`. Declined on no asker or a rejection
   * (an old laptop's `MethodNotFound`, a disconnect) — logged. A cancel is no
   * decision: not run this turn, and the next turn asks again. Never throws.
   */
  async resolveProjectTrust(
    sessionId: string,
    ask: AskHooksTrust | undefined,
    signal?: AbortSignal,
  ): Promise<void> {
    const request = this.projectTrustRequest();
    if (request === undefined || !this.needsProjectTrust()) {
      return;
    }
    let trusted = false;
    let cancelled = false;
    let why = "declined";
    if (ask === undefined) {
      why = "no client to ask";
    } else if (signal?.aborted) {
      cancelled = true;
    } else {
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<"aborted">((resolve) => {
        onAbort = () => resolve("aborted");
        signal?.addEventListener("abort", onAbort, { once: true });
      });
      try {
        const answer = await Promise.race([ask({ ...request, sessionId }, signal), aborted]);
        if (answer === "aborted") {
          cancelled = true;
        } else {
          trusted = answer === true;
        }
      } catch (error) {
        why = `the ask failed: ${error instanceof Error ? error.message : String(error)}`;
      } finally {
        if (onAbort) {
          signal?.removeEventListener("abort", onAbort);
        }
      }
    }
    if (cancelled) {
      this.opts.log?.(`project hooks of ${request.folder} not run this turn (cancelled)`);
      return;
    }
    // A concurrent decision (a sub-agent's) is kept; ours only fills "unknown".
    this.setProjectTrust(trusted);
    if (!trusted) {
      this.opts.log?.(`project hooks of ${request.folder} not run this session (${why})`);
    }
  }

  /** Record the session's decision (once: a later call is ignored). */
  setProjectTrust(trusted: boolean): void {
    if (this.trust.state === "unknown") {
      this.trust.state = trusted ? "trusted" : "declined";
    }
  }

  /**
   * A runner for a sub-agent: same specs/env, `agent` set (H2); `modelId`
   * when its type overrides the model (reported to `model_request` hooks).
   */
  forAgent(agent: HookAgentInfo, modelId?: string): HookRunner {
    return new HookRunner({
      ...this.opts,
      agent: { type: agent.type, description: agent.description },
      ...(modelId !== undefined ? { modelId } : {}),
    });
  }

  hasAny(event: HookEvent): boolean {
    return this.specs().some((s) => s.event === event);
  }

  /** The user's specs, then the project's when trusted (user first, same event). */
  private specs(): readonly HookSpec[] {
    const p = this.opts.project;
    return p !== undefined && this.trust.state === "trusted"
      ? [...this.opts.specs, ...p.specs]
      : this.opts.specs;
  }

  private isProject(spec: HookSpec): boolean {
    return this.opts.project?.specs.includes(spec) === true;
  }

  async toolCall(i: ToolEventInput & { readonly signal: AbortSignal }): Promise<ToolCallVerdict> {
    const votes: NamedVote[] = [];
    let input = i.input;
    for (const spec of this.matching("tool_call", i.toolName)) {
      if (i.signal.aborted) {
        break;
      }
      const hook = hookName(spec);
      const r = await this.run(spec, this.payload("tool_call", i, input), i.signal);
      // Killed by the user's cancel: not a hook failure, and no vote.
      if (i.signal.aborted) {
        break;
      }
      const parsed = parseToolCallOutcome(r, spec.onFailure);
      const vote = this.isProject(spec)
        ? projectVote(parsed, this.opts.project?.canAllow === true)
        : parsed;
      this.logFailure(hook, "tool_call", vote.kind === "none" ? vote.failure : undefined);
      votes.push({ hook, vote });
      if (vote.kind === "deny") {
        break;
      }
      if (vote.kind === "modify") {
        input = vote.input;
      }
    }
    return combineToolCallVotes(i.input, votes);
  }

  async toolResult(i: ToolEventInput & { readonly result: ToolResult }): Promise<ToolResult> {
    let result = i.result;
    for (const spec of this.matching("tool_result", i.toolName)) {
      if (i.signal?.aborted) {
        break;
      }
      const hook = hookName(spec);
      const payload = {
        ...this.payload("tool_result", i, i.input),
        tool_result: { content: result.content, is_error: result.isError === true },
      };
      const r = await this.run(spec, payload, i.signal);
      // Killed by the user's cancel: not a hook failure, leave the result as is.
      if (i.signal?.aborted) {
        break;
      }
      const vote = parseToolResultOutcome(r, spec.onFailure);
      if (vote.kind === "pass") {
        this.logFailure(hook, "tool_result", vote.failure);
        continue;
      }
      const isError = vote.isError ?? result.isError;
      const { isError: _drop, ...rest } = result;
      result = isError
        ? { ...rest, content: vote.content, isError }
        : { ...rest, content: vote.content };
    }
    return result;
  }

  /**
   * `turn_start`: each matching hook's `context` is one note (already
   * `[hook turn_start] …`), in config order; the first stop ends the run. A
   * hook killed by the user's cancel is no vote.
   */
  async turnStart(i: {
    readonly sessionId: string;
    readonly prompt: string;
    readonly signal?: AbortSignal;
  }): Promise<{ notes: string[]; stop: boolean; reason: string }> {
    const notes: string[] = [];
    for (const spec of this.byEvent("turn_start")) {
      if (i.signal?.aborted) {
        break;
      }
      const r = await this.run(
        spec,
        { ...this.base("turn_start", i.sessionId), prompt: i.prompt },
        i.signal,
      );
      if (i.signal?.aborted) {
        break;
      }
      const vote = parseTurnStartOutcome(r, spec.onFailure);
      if (vote.kind === "none") {
        this.logFailure(hookName(spec), "turn_start", vote.failure);
      } else if (vote.kind === "context") {
        notes.push(hookNote("turn_start", vote.text));
      } else {
        return { notes, stop: true, reason: vote.reason };
      }
    }
    return { notes, stop: false, reason: "" };
  }

  /**
   * `turn_end` with `end_turn`: continue if ANY matching hook says so; the
   * reasons are joined (none → "continue"). A cancel is no vote.
   */
  async turnEnd(i: {
    readonly sessionId: string;
    readonly reason: "end_turn";
    readonly lastAssistantMessage: string;
    readonly continued: number;
    readonly signal?: AbortSignal;
  }): Promise<{ continue: boolean; reason: string }> {
    let cont = false;
    const reasons: string[] = [];
    for (const spec of this.byEvent("turn_end")) {
      if (i.signal?.aborted) {
        break;
      }
      const payload = {
        ...this.base("turn_end", i.sessionId),
        reason: i.reason,
        last_assistant_message: i.lastAssistantMessage,
        continued: i.continued,
      };
      const r = await this.run(spec, payload, i.signal);
      if (i.signal?.aborted) {
        return { continue: false, reason: "" };
      }
      const vote = parseTurnEndOutcome(r, spec.onFailure);
      if (vote.kind === "stop") {
        this.logFailure(hookName(spec), "turn_end", vote.failure);
      } else {
        cont = true;
        if (vote.reason !== "") {
          reasons.push(vote.reason);
        }
      }
    }
    return { continue: cont, reason: reasons.length > 0 ? reasons.join("\n") : "continue" };
  }

  /** `turn_end` for a turn that stopped otherwise: a notification. Never throws. */
  async turnEndNotify(i: {
    readonly sessionId: string;
    readonly reason: "cancelled" | "max_iterations";
  }): Promise<void> {
    for (const spec of this.byEvent("turn_end")) {
      const r = await this.run(spec, { ...this.base("turn_end", i.sessionId), reason: i.reason });
      this.logFailure(hookName(spec), "turn_end", notifyFailure(r));
    }
  }

  /**
   * `model_request`: a read-only notification before a model call, never
   * awaited. At most one in flight per session: a call arriving meanwhile is
   * dropped, logged once per burst (R3). Never throws.
   */
  notifyModelRequest(i: {
    readonly sessionId: string;
    readonly iteration: number | "final";
    readonly messages: readonly ChatMessage[];
    readonly toolNames: readonly string[];
  }): void {
    if (this.opts.modelRequestHooks !== true || !this.hasAny("model_request")) {
      return;
    }
    if (this.modelRequestBusy.has(i.sessionId)) {
      if (!this.modelRequestDropLogged.has(i.sessionId)) {
        this.modelRequestDropLogged.add(i.sessionId);
        this.opts.log?.("hook model_request: previous notification still running, dropped");
      }
      return;
    }
    this.modelRequestDropLogged.delete(i.sessionId);
    const delta = modelRequestDelta(i.messages, this.modelRequestCounts.get(i.sessionId));
    this.modelRequestCounts.set(i.sessionId, i.messages.length);
    const payload = {
      ...this.base("model_request", i.sessionId),
      iteration: i.iteration,
      model: this.opts.modelId ?? null,
      message_count: i.messages.length,
      tool_names: i.toolNames,
      new_messages: delta.map((m) => ({ role: m.role, content: m.content })),
    };
    this.modelRequestBusy.add(i.sessionId);
    void (async () => {
      try {
        for (const spec of this.byEvent("model_request")) {
          const r = await this.run(spec, payload);
          this.logFailure(hookName(spec), "model_request", notifyFailure(r));
        }
      } finally {
        this.modelRequestBusy.delete(i.sessionId);
      }
    })();
  }

  private byEvent(event: HookEvent): HookSpec[] {
    return this.specs().filter((s) => s.event === event);
  }

  private base(event: HookEvent, sessionId: string): Record<string, unknown> {
    return { event, session_id: sessionId, cwd: this.opts.cwd, agent: this.opts.agent ?? null };
  }

  private matching(event: HookEvent, toolName: string): HookSpec[] {
    return this.specs().filter((s) => s.event === event && hookMatches(s, toolName));
  }

  private payload(event: HookEvent, i: ToolEventInput, input: unknown): Record<string, unknown> {
    return {
      event,
      session_id: i.sessionId,
      cwd: this.opts.cwd,
      agent: this.opts.agent ?? null,
      tool_name: i.toolName,
      tool_call_id: i.toolCallId,
      tool_input: input,
    };
  }

  private async run(
    spec: HookSpec,
    payload: unknown,
    signal?: AbortSignal,
  ): Promise<HookProcessOutcome> {
    const timeoutMs = (spec.timeout ?? DEFAULT_TIMEOUT_S) * 1000;
    const started = Date.now();
    try {
      const r = await this.opts.env.exec(spec.command, {
        stdin: JSON.stringify(payload),
        timeoutMs,
        cwd: this.opts.cwd,
        env: {
          TENTACLE_HOOK_EVENT: String((payload as { event: string }).event),
          TENTACLE_PROJECT_DIR: this.opts.cwd,
        },
        ...(signal ? { signal } : {}),
      });
      // HostExecution reports a killed process as 124: ours, if the clock ran out.
      return r.exitCode === 124 && Date.now() - started >= timeoutMs ? "timeout" : r;
    } catch {
      return "error";
    }
  }

  private logFailure(hook: string, event: HookEvent, failure: string | undefined): void {
    if (failure !== undefined) {
      this.opts.log?.(`hook ${hook} (${event}) failed, ignored: ${failure}`);
    }
  }
}

/** A notification hook's failure, if any (its output is ignored). */
function notifyFailure(r: HookProcessOutcome): string | undefined {
  const c = classify(r);
  return "failure" in c ? c.failure : undefined;
}

/**
 * The `tool_result` pipeline stage. It reads the runner from the context, so
 * the one shared transform list uses each agent's own runner (a sub-agent's
 * carries its identity, H2). Identity when no runner / no `tool_result` hook.
 */
export const runResultHooks: ResultTransform = (result, ctx) =>
  ctx.hooks?.hasAny("tool_result")
    ? ctx.hooks.toolResult({
        sessionId: ctx.sessionId ?? "",
        toolName: ctx.toolName,
        toolCallId: ctx.toolCallId,
        input: ctx.input ?? {},
        result,
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
    : result;
