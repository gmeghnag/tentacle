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
const DEFAULT_TIMEOUT_S = 600;
const DEFAULT_REASON = "blocked by hook";

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
}

interface ToolEventInput {
  readonly sessionId: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly input: unknown;
  readonly signal?: AbortSignal;
}

export class HookRunner {
  constructor(private readonly opts: HookRunnerOptions) {}

  /** A runner for a sub-agent: same specs/env, `agent` set (H2). */
  forAgent(agent: HookAgentInfo): HookRunner {
    return new HookRunner({
      ...this.opts,
      agent: { type: agent.type, description: agent.description },
    });
  }

  hasAny(event: HookEvent): boolean {
    return this.opts.specs.some((s) => s.event === event);
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
      const vote = parseToolCallOutcome(r, spec.onFailure);
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

  private matching(event: HookEvent, toolName: string): HookSpec[] {
    return this.opts.specs.filter((s) => s.event === event && hookMatches(s, toolName));
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
