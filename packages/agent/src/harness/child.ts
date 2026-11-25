/**
 * A sub-agent run by another agent harness (docs/feat/subagent-harness-runners.md
 * D3, D6, D10): `runHarnessChild` maps a `HarnessAdapter` run onto the SAME
 * seam a tentacle child uses — `subagent_tool` / `subagent_usage` /
 * `subagent_end`, a `SubagentResult`, or a `SubagentFailure` with its partial
 * report. The runner owns the limits every adapter shares (D2): the hang guard
 * (paused while an ask is pending) and a call's own token cap.
 *
 * A permission ask is decided by `authorizeHarnessAsk` (D4): the session's gate
 * → `subagentRequester` → the ONE broker.
 */

import { SubagentFailure, type ToolContext, type ToolProgressEvent } from "@tentacle/core";
import type { AgentStopReason } from "../agent.ts";
import type {
  AgentType,
  SubagentResult,
  SubagentRunControls,
  SubagentRunOptions,
} from "../subagent.ts";
import { STEP_VERDICT_TOOL_NAME } from "../workflow-verdict.ts";
import { isModelShape } from "./claude-code.ts";
import { type HarnessPermissions, authorizeHarnessAsk } from "./permissions.ts";
import type {
  HarnessAdapter,
  HarnessEvent,
  HarnessHandle,
  HarnessProbe,
  HarnessRun,
} from "./types.ts";
import {
  type SnapshotWorktree,
  type WorktreeOutcome,
  createSnapshotWorktree,
  finishWorktree,
} from "./worktree.ts";

/** A configured harness instance (`harnesses.<name>`). */
export interface HarnessInstance {
  readonly adapter: HarnessAdapter;
  /** The model when the call names none (`harnesses.<name>.model`). */
  readonly model?: string;
  /** Hang guard: no event for this long ends the run (paused while an ask waits). */
  readonly idleMinutes: number;
  /** Where a remote `input` question goes (Owner A9). Default `parent`. */
  readonly inputFrom?: "parent" | "user" | "both";
  /** The footer's resume hint for a handle (`claude --resume <id>`). */
  readonly resumeHint?: (handle: HarnessHandle) => string;
}

export interface HarnessWorktrees {
  create(opts: { cwd: string; id: string }): Promise<SnapshotWorktree>;
  finish(wt: SnapshotWorktree): Promise<WorktreeOutcome>;
}

export interface HarnessDeps {
  /** By instance name (`AgentType.harness.adapter`). */
  readonly instances: ReadonlyMap<string, HarnessInstance>;
  /** The session's cwd: the tree a write run snapshots (D8). */
  readonly cwd: string;
  /** Default: the real snapshot worktree (`worktree.ts`). */
  readonly worktrees?: HarnessWorktrees;
  /** D10 `input` → the parent (two-way); wired with the remote adapter (`feat/a2a`). */
  readonly askParent?: (agentId: string, question: string, signal: AbortSignal) => Promise<string>;
  /** D10 `input` → the user, through the broker; wired with `feat/a2a`. */
  readonly askUser?: (question: string, signal: AbortSignal) => Promise<string>;
  /** `disconnected` → `reattach`, bounded. Default 3 attempts, 1 s doubling. */
  readonly reattach?: { readonly attempts: number; readonly backoffMs: number };
  /** The run / worktree id. */
  readonly newId?: () => string;
}

/** A type that names a harness (D3): its adapter kind must match its mode (D10). */
export function harnessModeIssue(
  type: AgentType,
  adapter: Pick<HarnessAdapter, "id" | "kind">,
): string | undefined {
  const mode = type.harness?.mode;
  if (adapter.kind === "remote" && mode !== "remote") {
    return `${type.name}: the remote harness ${adapter.id} accepts only mode "remote"`;
  }
  if (adapter.kind === "local-process" && mode !== "write") {
    return `${type.name}: the local harness ${adapter.id} accepts only mode "write"`;
  }
  return undefined;
}

/** Probed once per adapter object (one per wiring), at first use. */
const probes = new WeakMap<HarnessAdapter, Promise<HarnessProbe>>();
function probeOnce(adapter: HarnessAdapter, signal: AbortSignal): Promise<HarnessProbe> {
  let p = probes.get(adapter);
  if (p === undefined) {
    p = adapter
      .probe(signal)
      .catch((err: unknown): HarnessProbe => ({ ok: false, reason: errText(err) }));
    probes.set(adapter, p);
  }
  return p;
}

/**
 * D9: the result a workflow step's harness child must return (`--json-schema`).
 * `step_verdict` is OUR tool, so the child cannot call it: its `structured`
 * result is fed to the step's own verdict tool instead.
 */
export const HARNESS_VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    reason: { type: "string", minLength: 1 },
    report: { type: "string" },
  },
  required: ["verdict", "reason"],
  additionalProperties: false,
} as const;

const DATA_CAP = 4096;
const WINDOW_LABEL: Readonly<Record<string, string>> = { five_hour: "5h", seven_day: "7d" };

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Step =
  | { readonly t: "event"; readonly r: IteratorResult<HarnessEvent> }
  | { readonly t: "idle" }
  | { readonly t: "abort" };

/**
 * Run one harness child. `subagent_start` was already emitted by the runner;
 * this emits the rest and `subagent_end`, exactly once.
 */
export async function runHarnessChild(
  type: AgentType,
  opts: SubagentRunOptions,
  controls: SubagentRunControls | undefined,
  deps: HarnessDeps | undefined,
  /** The child's gate inputs (D4). Absent: every permission ask is denied. */
  permissions?: HarnessPermissions,
): Promise<SubagentResult> {
  const onEvent = (event: ToolProgressEvent): void => controls?.onEvent?.(event);
  const name = type.name;
  let toolUses = 0;
  let report = "";
  const fail = (message: string, cause?: unknown): never => {
    controls?.inbox?.close();
    onEvent({ kind: "subagent_end", toolUses, stopReason: "error" });
    throw new SubagentFailure(message, {
      partialReport: report,
      toolUses,
      ...(cause !== undefined ? { cause } : {}),
    });
  };

  const instance = type.harness ? deps?.instances.get(type.harness.adapter) : undefined;
  if (!type.harness || !deps || !instance) {
    return fail(`${name}: no harness ${type.harness?.adapter ?? ""} is available here`.trim());
  }
  const adapter = instance.adapter;
  const modeIssue = harnessModeIssue(type, adapter);
  if (modeIssue !== undefined) return fail(modeIssue);
  const model = opts.model ?? instance.model;
  if (model !== undefined && !isModelShape(model)) {
    return fail(`${name}: invalid model ${JSON.stringify(model.slice(0, 64))}`);
  }

  const own = new AbortController();
  const outer = controls?.signal;
  const onOuterAbort = (): void => own.abort();
  if (outer?.aborted) own.abort();
  else outer?.addEventListener("abort", onOuterAbort, { once: true });

  let worktree: SnapshotWorktree | undefined;
  let worktreeNote = "";
  const worktrees: HarnessWorktrees = deps.worktrees ?? {
    create: (o) => createSnapshotWorktree(o),
    finish: (wt) => finishWorktree(wt),
  };
  const closeWorktree = async (): Promise<void> => {
    if (worktree === undefined) return;
    const outcome = await worktrees.finish(worktree);
    worktree = undefined;
    if (outcome.changed) {
      // Committed: the branch's last commit is the run's work (its parent, the
      // baseline, is the user's own uncommitted state at the start).
      worktreeNote = outcome.committed
        ? `\n\nChanges committed on branch \`${outcome.branch}\` (the run's work is its last commit; worktree at ${outcome.path}; never merged by tentacle):\n${outcome.diffstat}`
        : `\n\nChanges left uncommitted in the worktree at ${outcome.path} (never merged by tentacle):\n${outcome.diffstat}`;
    }
  };

  let handle: HarnessHandle | undefined;
  const quotas = new Map<string, Extract<HarnessEvent, { kind: "quota" }>>();
  let costUsd: number | undefined;
  const footer = (): string => {
    const parts = [`— ${name}`, model ?? "default"];
    parts.push(
      adapter.caps.cost && costUsd !== undefined
        ? `$${costUsd.toFixed(2)} (list)`
        : "cost: not reported",
    );
    for (const q of quotas.values()) {
      if (q.utilization !== undefined) {
        parts.push(`${WINDOW_LABEL[q.window] ?? q.window} ${Math.round(q.utilization * 100)}%`);
      }
    }
    if (handle !== undefined) {
      parts.push(
        instance.resumeHint
          ? `session ${handle.id} (${instance.resumeHint(handle)})`
          : `task ${handle.id}`,
      );
    }
    return `\n\n${parts.join(" · ")}`;
  };
  const failRun = async (message: string, cause?: unknown): Promise<never> => {
    await closeWorktree().catch(() => {});
    report = `${report}${worktreeNote}${footer()}`.trim();
    return fail(message, cause);
  };

  try {
    const probe = await probeOnce(adapter, own.signal);
    if (!probe.ok) return await failRun(probe.reason ?? `${adapter.id} is not usable`);

    const runId = (deps.newId ?? (() => crypto.randomUUID().slice(0, 8)))();
    if (adapter.caps.workspace === "local") {
      try {
        worktree = await worktrees.create({ cwd: deps.cwd, id: runId });
      } catch (err) {
        return await failRun(`${name}: ${errText(err)}`, err);
      }
    }

    const verdictTool = controls?.extraTools?.find((t) => t.name === STEP_VERDICT_TOOL_NAME);
    let run: HarnessRun;
    try {
      run = await adapter.start(
        {
          prompt: opts.prompt,
          mode: type.harness.mode,
          runId,
          ...(worktree !== undefined ? { cwd: worktree.path } : {}),
          ...(model !== undefined ? { model } : {}),
          ...(verdictTool !== undefined && adapter.caps.structuredResult
            ? { jsonSchema: HARNESS_VERDICT_SCHEMA }
            : {}),
        },
        own.signal,
      );
    } catch (err) {
      return await failRun(`${name}: ${errText(err)}`, err);
    }

    const idleMs = instance.idleMinutes * 60_000;
    const maxTokens = controls?.maxTokens;
    const reattach = deps.reattach ?? { attempts: 3, backoffMs: 1000 };
    let it = run.events[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<HarnessEvent>> | undefined;
    let tokens = 0;
    let budgetHit = false;
    let abortSeen = false;
    let quotaHit: Extract<HarnessEvent, { kind: "quota" }> | undefined;
    let end: Extract<HarnessEvent, { kind: "end" }> | undefined;
    let localCancel = false;
    let reattaches = 0;
    const abortP = new Promise<Step>((resolve) => {
      if (own.signal.aborted) resolve({ t: "abort" });
      else own.signal.addEventListener("abort", () => resolve({ t: "abort" }), { once: true });
    });

    for (;;) {
      pending ??= it.next();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idleP = new Promise<Step>((resolve) => {
        timer = setTimeout(() => resolve({ t: "idle" }), idleMs);
      });
      let step: Step;
      try {
        step = await Promise.race([
          pending.then((r): Step => ({ t: "event", r })),
          idleP,
          ...(abortSeen ? [] : [abortP]),
        ]);
      } catch (err) {
        clearTimeout(timer);
        return await failRun(`${name}: ${errText(err)}`, err);
      } finally {
        clearTimeout(timer);
      }

      if (step.t === "abort") {
        abortSeen = true;
        if ((await run.cancel()) === "unconfirmed") {
          localCancel = true;
          break;
        }
        continue; // a confirmed cancel ends the stream (`end cancelled`, cost kept)
      }
      if (step.t === "idle") {
        await run.cancel().catch(() => "unconfirmed" as const);
        return await failRun(
          `${name}: no output for ${instance.idleMinutes} min — stopped (hang guard)`,
        );
      }
      pending = undefined;
      if (step.r.done) break;
      const ev = step.r.value;
      switch (ev.kind) {
        case "started":
          handle = ev.handle;
          break;
        case "progress":
          toolUses += 1;
          onEvent({ kind: "subagent_tool", label: ev.label });
          break;
        case "usage":
          tokens += ev.promptTokens + ev.completionTokens;
          onEvent({
            kind: "subagent_usage",
            promptTokens: ev.promptTokens,
            completionTokens: ev.completionTokens,
          });
          if (!budgetHit && maxTokens !== undefined && maxTokens > 0 && tokens >= maxTokens) {
            budgetHit = true;
            void run.cancel();
          }
          break;
        case "quota":
          quotas.set(ev.window, ev);
          if (!ev.allowed) quotaHit = ev;
          break;
        case "ask":
          if (ev.ask.type === "permission") {
            // Decided while the hang guard is paused; the run's signal withdraws it.
            const decision = await authorizeHarnessAsk(permissions, ev.ask, {
              askId: ev.askId,
              signal: own.signal,
              ...(worktree !== undefined ? { worktreeRoot: worktree.path } : {}),
            });
            await run.answer(ev.askId, decision);
          } else if (ev.ask.type === "auth") {
            await run.cancel().catch(() => "unconfirmed" as const);
            return await failRun(
              `${name} needs authentication: ${ev.ask.explanation} — configure credentials for ${adapter.id}`,
            );
          } else {
            const answer = await routeInput(ev.ask.question, instance, deps, controls, own.signal);
            if (answer === undefined) {
              // No route (or nobody answered): end with the question, never wait forever.
              await run.cancel().catch(() => "unconfirmed" as const);
              await closeWorktree().catch(() => {});
              const unread = controls?.inbox?.close() ?? [];
              report = `${name} needs input to continue: ${ev.ask.question}${worktreeNote}${footer()}`;
              if (unread.length > 0) report += unreadNote(unread.length);
              onEvent({ kind: "subagent_end", toolUses, stopReason: "end_turn" });
              return { report, toolUses, stopReason: "end_turn" };
            }
            await run.answer(ev.askId, { allow: true, input: answer });
          }
          break;
        case "output":
          if (ev.text) report += ev.text;
          if (ev.data !== undefined) report += `\n${capped(JSON.stringify(ev.data) ?? "")}`;
          if (ev.file) {
            const f = ev.file;
            report += `\n[file] ${f.name ?? "(unnamed)"} (${f.mediaType ?? "unknown type"}${f.bytes !== undefined ? `, ${f.bytes} bytes` : ""}) — listed, not saved`;
          }
          break;
        case "disconnected": {
          if (!adapter.reattach || handle === undefined) {
            return await failRun(`${name}: disconnected (${ev.reason})`);
          }
          let next: HarnessRun | undefined;
          while (next === undefined && reattaches < reattach.attempts) {
            await delay(reattach.backoffMs * 2 ** reattaches);
            reattaches += 1;
            next = await adapter.reattach(handle, own.signal).catch(() => undefined);
          }
          if (next === undefined) {
            return await failRun(
              `${name}: disconnected (${ev.reason}); reattach failed ${reattaches} time(s) — the remote task may still be running (task ${handle.id} on ${handle.adapter}); progress shown may be incomplete`,
            );
          }
          run = next;
          it = run.events[Symbol.asyncIterator]();
          break;
        }
        case "end":
          end = ev;
          break;
      }
      if (end !== undefined) break;
    }

    if (end?.costUsd !== undefined) costUsd = end.costUsd;
    let stopReason: AgentStopReason;
    if (localCancel) {
      stopReason = "cancelled";
      report += `\n\n(cancel not confirmed: the remote task may still be running${handle ? ` (task ${handle.id})` : ""})`;
    } else if (end === undefined) {
      if (!abortSeen) return await failRun(`${name}: the run ended without a result`);
      stopReason = "cancelled";
    } else if (end.status === "failed" || end.status === "rejected") {
      if (end.text && !report.includes(end.text)) report += end.text;
      const why = end.error ?? end.text ?? end.status;
      const quota =
        quotaHit !== undefined
          ? ` (quota: ${WINDOW_LABEL[quotaHit.window] ?? quotaHit.window} window reached${quotaHit.resetsAt !== undefined ? `, resets ${new Date(quotaHit.resetsAt * 1000).toISOString()}` : ""})`
          : "";
      return await failRun(
        end.status === "rejected" ? `rejected by ${adapter.id}: ${why}` : `${name}: ${why}${quota}`,
      );
    } else {
      const verdict = verdictFrom(end.structured);
      if (verdictTool !== undefined && verdict !== undefined) {
        // The step's own verdict tool records it (the driver reads it unchanged).
        await verdictTool.execute({ verdict: verdict.verdict, reason: verdict.reason }, {
          sessionId: controls?.sessionId ?? "",
          signal: own.signal,
        } as ToolContext);
        report += verdict.report ?? end.text ?? "";
      } else if (end.text) report += end.text;
      stopReason =
        budgetHit || end.status === "budget"
          ? "max_token_budget"
          : end.status === "cancelled"
            ? "cancelled"
            : "end_turn";
    }

    await closeWorktree().catch(() => {});
    const unread = controls?.inbox?.close() ?? [];
    const trimmed = report.trim();
    const body =
      trimmed !== ""
        ? trimmed
        : `(The ${name} sub-agent finished (${stopReason}) after ${toolUses} tool use(s) without producing a report.)`;
    const budgetNote =
      stopReason === "max_token_budget" && maxTokens !== undefined && maxTokens > 0
        ? `\n\n(token budget reached: ${tokens.toLocaleString("en-US")} of ${maxTokens.toLocaleString("en-US")} tokens used)`
        : "";
    onEvent({ kind: "subagent_end", toolUses, stopReason });
    return {
      report: `${body}${worktreeNote}${footer()}${budgetNote}${unread.length > 0 ? unreadNote(unread.length) : ""}`,
      toolUses,
      stopReason,
    };
  } finally {
    outer?.removeEventListener("abort", onOuterAbort);
    await closeWorktree().catch(() => {});
  }
}

function verdictFrom(
  value: unknown,
): { verdict: "pass" | "fail"; reason: string; report?: string } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if ((v.verdict !== "pass" && v.verdict !== "fail") || typeof v.reason !== "string") {
    return undefined;
  }
  return {
    verdict: v.verdict,
    reason: v.reason,
    ...(typeof v.report === "string" && v.report !== "" ? { report: v.report } : {}),
  };
}

function unreadNote(n: number): string {
  return `\n\n(${n} message(s) sent to this sub-agent arrived after it stopped and were not read.)`;
}

function capped(text: string): string {
  return text.length > DATA_CAP ? `${text.slice(0, DATA_CAP)}… (${text.length} chars)` : text;
}

/**
 * D10 `input`: the configured routes race; the FIRST answer wins and the others
 * are withdrawn (their signal aborts). `undefined` = no route, or none answered.
 */
async function routeInput(
  question: string,
  instance: HarnessInstance,
  deps: HarnessDeps,
  controls: SubagentRunControls | undefined,
  signal: AbortSignal,
): Promise<string | undefined> {
  const from = instance.inputFrom ?? "parent";
  const withdraw = new AbortController();
  const onAbort = (): void => withdraw.abort();
  signal.addEventListener("abort", onAbort, { once: true });
  const routes: Promise<string>[] = [];
  const agentId = controls?.agentId;
  if ((from === "parent" || from === "both") && deps.askParent && agentId !== undefined) {
    routes.push(deps.askParent(agentId, question, withdraw.signal));
  }
  if ((from === "user" || from === "both") && deps.askUser) {
    routes.push(deps.askUser(question, withdraw.signal));
  }
  try {
    return routes.length === 0 ? undefined : await Promise.any(routes);
  } catch {
    return undefined;
  } finally {
    withdraw.abort();
    signal.removeEventListener("abort", onAbort);
  }
}
