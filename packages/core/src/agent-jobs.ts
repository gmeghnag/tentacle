/**
 * The runtime of a BACKGROUND sub-agent (docs/feat/subagent-background.md): the
 * controllers of the children the agent launched with `agent_task{background}`
 * and the ONE cap (`subagents.maxParallel`) they share with foreground children.
 *
 * Pure: no I/O, no clock, no React. The durable half (the `sa-N` id, the log
 * markers) is `AgentJobLedger`, owned by the daemon's `HostedSession`, which
 * reaches this class through the `AgentJobHost` it binds.
 *
 * Over the cap nothing waits: a launch, background or foreground, is REFUSED at
 * once with the running children named, so the model decides (owner Q2 b).
 */
import { SUBAGENT_REPORT_MAX_CHARS } from "@tentacle/protocol";
import { capSubagentText } from "./agent-job-ledger.ts";

export interface AgentJobSpec {
  readonly callId: string;
  readonly agentType: string;
  readonly description: string;
}

/** Bound by `HostedSession`. Absent (a one-shot, `plain`): background launches are refused. */
export interface AgentJobHost {
  /** Mints the `sa-N` id; logs + persists the launch. */
  launched(spec: AgentJobSpec): string;
  /** Logs + persists the end. */
  ended(agentId: string, stopReason: string, report: string): void;
}

export interface AgentJobResult {
  readonly report: string;
  readonly toolUses: number;
  readonly stopReason: string;
}

export interface AgentJobControls {
  /** The child's own signal: NEVER the launching turn's. */
  readonly signal: AbortSignal;
  readonly agentId: string;
}

export interface RunningAgentJob extends AgentJobSpec {
  readonly agentId: string;
}

export interface AgentJobExit extends RunningAgentJob, AgentJobResult {}

export type AgentJobStart =
  | { readonly ok: true; readonly agentId: string }
  | { readonly ok: false; readonly reason: string };

/** A foreground child's slot. `release` is idempotent. */
export type AgentSlot =
  | { readonly ok: true; readonly release: () => void }
  | { readonly ok: false; readonly reason: string };

const NO_OUTPUT = "(the sub-agent produced no output)";

export class AgentJobs {
  private cap: number;
  private host: AgentJobHost | undefined;
  private disposed = false;
  private readonly running = new Map<
    string,
    { readonly job: RunningAgentJob; readonly controller: AbortController }
  >();
  /** Foreground children holding a slot: a token each, with its description for the refusal. */
  private readonly foreground = new Map<symbol, string>();
  private readonly listeners = new Set<(exit: AgentJobExit) => void>();

  constructor(maxParallel: number) {
    this.cap = maxParallel;
  }

  /** A settings sync changed `subagents.maxParallel`. Kills nothing; new work sees it. */
  setCap(maxParallel: number): void {
    this.cap = maxParallel;
  }

  bind(host: AgentJobHost): void {
    this.host = host;
  }

  list(): readonly RunningAgentJob[] {
    return [...this.running.values()].map((entry) => entry.job);
  }

  onExit(listener: (exit: AgentJobExit) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Launch a child in the background. Synchronous end to end: it either
   * starts (and returns its id) or is refused with a reason for the model.
   */
  start(
    spec: AgentJobSpec,
    run: (controls: AgentJobControls) => Promise<AgentJobResult>,
  ): AgentJobStart {
    const host = this.host;
    if (this.disposed || host === undefined) {
      return {
        ok: false,
        reason: "background sub-agents are not available in this mode: run it in the foreground",
      };
    }
    if (this.used() >= this.cap) {
      return { ok: false, reason: this.refusal() };
    }
    const agentId = host.launched(spec);
    const controller = new AbortController();
    this.running.set(agentId, { job: { ...spec, agentId }, controller });
    // Last net: nothing `drive` can throw may escape as an unhandled rejection
    // (Bun exits the process on one). `drive` handles its own failures.
    void this.drive(agentId, spec, controller, run).catch(() => {});
    return { ok: true, agentId };
  }

  /**
   * A foreground child takes a slot, or is refused at once (never waits): the
   * foreground is as full as the background. The caller releases in `finally`.
   */
  acquire(description: string): AgentSlot {
    if (this.disposed) {
      // A disposed runtime holds nothing: a "limit" here would be a lie.
      return { ok: false, reason: "sub-agents are not available: the session is closing" };
    }
    if (this.used() >= this.cap) {
      return { ok: false, reason: this.refusal() };
    }
    const token = Symbol("foreground");
    this.foreground.set(token, description);
    return { ok: true, release: () => void this.foreground.delete(token) };
  }

  /** Aborts every child. No `ended`, no exit: the session is going away. */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    for (const { controller } of this.running.values()) {
      controller.abort();
    }
    this.running.clear();
    this.foreground.clear();
  }

  private used(): number {
    return this.running.size + this.foreground.size;
  }

  private refusal(): string {
    const named = [
      ...this.list().map((job) => `${job.agentId} (${job.description})`),
      ...[...this.foreground.values()].map((description) => `(foreground) ${description}`),
    ];
    // "End your turn and be woken" is only true when a background child runs:
    // foreground holders alone wake nobody, so ending the turn would stall the task.
    const next =
      this.running.size > 0
        ? "Either end your turn (you are woken by a [background] note when a background sub-agent finishes) or do this work yourself."
        : "Retry when the running foreground sub-agents return, or do this work yourself.";
    return `at the sub-agent limit (subagents.maxParallel = ${this.cap}); running: ${
      named.length > 0 ? named.join(", ") : "none"
    }. Nothing was started. ${next}`;
  }

  private async drive(
    agentId: string,
    spec: AgentJobSpec,
    controller: AbortController,
    run: (controls: AgentJobControls) => Promise<AgentJobResult>,
  ): Promise<void> {
    let result: AgentJobResult;
    try {
      result = await run({ signal: controller.signal, agentId });
    } catch (error) {
      result = {
        report: `the sub-agent failed: ${error instanceof Error ? error.message : String(error)}`,
        toolUses: 0,
        stopReason: "error",
      };
    }
    this.running.delete(agentId);
    if (this.disposed) {
      return;
    }
    const report = capSubagentText(
      result.report.trim() === "" ? NO_OUTPUT : result.report,
      SUBAGENT_REPORT_MAX_CHARS,
    );
    try {
      this.host?.ended(agentId, result.stopReason, report);
    } catch {
      // Durability is lost, but the live note and the wake still go out: the
      // listeners below run unconditionally, and nothing is left rejected.
    }
    const exit: AgentJobExit = { ...spec, agentId, ...result, report };
    for (const listener of [...this.listeners]) {
      try {
        listener(exit);
      } catch {
        // A throwing listener never loses the others.
      }
    }
  }
}
