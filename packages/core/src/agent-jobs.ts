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
import {
  AGENT_INBOX_MAX,
  AGENT_MESSAGE_MAX_CHARS,
  AgentInbox,
  type AgentMessageSender,
  inboxText,
} from "./agent-inbox.ts";
import { capSubagentText } from "./agent-job-ledger.ts";
import type { ToolProgressEvent } from "./tool.ts";

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
  /**
   * Now, for a row's `startedAt`. Optional: the class keeps no clock of its own
   * (a test's rows then read 0, which is honest).
   */
  now?(): number;
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
  /** What every sender writes into this child (`AgentJobs.message`). */
  readonly inbox: AgentInbox;
}

export interface RunningAgentJob extends AgentJobSpec {
  readonly agentId: string;
}

/** What `AgentJobs.message` answers: nothing throws, the sender reports. */
export type AgentMessageResult =
  | {
      readonly ok: true;
      /** Its place among the sender's messages to this child (1-based, cumulative). */
      readonly index: number;
    }
  | { readonly ok: false; readonly reason: string };

export interface AgentJobExit extends RunningAgentJob, AgentJobResult {}

/**
 * What a running background child's `agent_notify` asks its parent agent to
 * read (docs/feat/agent-message-two-way.md). `wakes` is the wake budget's
 * decision: a note over it is still delivered, and wakes nobody.
 */
export interface AgentNotify {
  readonly agentId: string;
  readonly description: string;
  readonly text: string;
  readonly wakes: boolean;
}

/** What `AgentJobs.notify` answers: nothing throws, the child's tool reports. */
export type AgentNotifyResult =
  | { readonly ok: true; readonly wakes: boolean }
  | { readonly ok: false; readonly reason: string };

/** Accepted notifies per child between two user messages (owner Q1 a). */
export const AGENT_NOTIFY_PER_CHILD = 8;
/** Waking notifies per session between two user messages (owner Q1 a, eval B3). */
export const AGENT_NOTIFY_WAKES = 3;

export type AgentJobStart =
  | { readonly ok: true; readonly agentId: string }
  | { readonly ok: false; readonly reason: string };

/**
 * A foreground child's slot (`docs/feat/subagent-detach.md`). `release` is
 * idempotent, and a no-op once the slot was adopted.
 */
export type AgentSlot =
  | {
      readonly ok: true;
      readonly release: () => void;
      /** The inbox this child drains; `adopt` moves IT into the running entry. */
      readonly inbox: AgentInbox;
      /**
       * Register what turns this child into a background one, when a person
       * writes while it runs (`HostedSession.enqueue` / `send_now`). Called by
       * `detachForeground`, in its own `try`; a no-op once the slot is gone.
       */
      readonly movable: (move: () => void) => void;
      /**
       * Exchange this slot for a running entry, in ONE synchronous stretch:
       * `launched` first (a throw leaves the child foreground, nothing
       * half-moved), then the maps. `undefined` when there is nothing to
       * exchange (disposed, no host, the slot already released or adopted).
       * NO cap check (F8): one slot becomes one entry, `used()` is unchanged.
       */
      readonly adopt: (
        spec: AgentJobSpec,
        controller: AbortController,
        seed: AgentJobLive,
        run: (controls: AgentJobControls) => Promise<AgentJobResult>,
      ) => string | undefined;
    }
  | { readonly ok: false; readonly reason: string };

/** A child's visible state so far (a row's counts, and what a move carries over). */
export interface AgentJobLive {
  toolUses: number;
  tokens: number;
  tail: string[];
  /**
   * The `models` NAME the child's pick named, from its `subagent_start` (never an
   * id: AGENTS §7). Whether a row SHOWS it is decided on every publish, against
   * the main agent's model of that moment (docs/feat/subagent-panel.md, M2).
   */
  model?: string;
  /**
   * The model ID the child really runs on — DAEMON-side only (it never reaches
   * the wire), which is what "differs from the main model" is decided against.
   */
  modelId?: string;
}

/** One child as a client shows it (docs/feat/subagent-background-ui.md Design 2). */
export interface AgentJobRow {
  readonly id: string;
  readonly callId: string;
  readonly agentType: string;
  readonly description: string;
  readonly state: string;
  readonly toolUses: number;
  /** The child's own tokens so far (never the parent's). */
  readonly tokens: number;
  readonly startedAt: number;
  /** Its recent tool labels, oldest first, at most `TAIL_MAX`. */
  readonly tail: readonly string[];
  /** The `models` NAME its pick named; shown only when it differs (M2). */
  readonly model?: string;
  /**
   * How many of the USER's messages this child has read (taken into its own
   * context): what the drawer compares a message's `n` against for `✓ read`
   * (docs/fix/autoaccept-wake-turns.md, part B). The inbox's own count.
   */
  readonly userRead: number;
  /**
   * The model ID it really runs on: DAEMON-side only (never on the wire).
   * `subagentRows` compares it with the main model's current id.
   */
  readonly modelId?: string;
}

/** How many labels a row keeps: enough for a panel, never a log. */
export const AGENT_ROW_TAIL_MAX = 8;

/**
 * Fold one progress event of a child into its visible state. Returns whether
 * anything visible changed, so the caller decides to publish.
 *
 * Exported because a FOREGROUND child folds the same way (`agent_task`'s
 * movable path): a detach hands that state over as the new row's seed, so the
 * row is honest at the moment of the move (docs/feat/subagent-detach.md).
 */
export function foldAgentProgress(live: AgentJobLive, event: ToolProgressEvent): boolean {
  if (event.kind === "subagent_tool") {
    live.toolUses += 1;
    live.tail.push(event.label);
    if (live.tail.length > AGENT_ROW_TAIL_MAX) {
      live.tail.splice(0, live.tail.length - AGENT_ROW_TAIL_MAX);
    }
  } else if (event.kind === "subagent_usage") {
    live.tokens += event.promptTokens + event.completionTokens;
  } else if (event.kind === "subagent_start") {
    // The child's model, both halves: the NAME is what a row may show, the ID is
    // what "same as the main model" is decided against (daemon-side). The ID
    // alone is never a visible change (it cannot change again), so only the NAME
    // decides whether this publishes (docs/feat/subagent-panel.md, M2).
    live.modelId = event.modelId;
    if (event.model === undefined || event.model === live.model) {
      return false;
    }
    live.model = event.model;
    return true;
  } else {
    return false;
  }
  return true;
}

const NO_OUTPUT = "(the sub-agent produced no output)";

export class AgentJobs {
  private cap: number;
  private host: AgentJobHost | undefined;
  private disposed = false;
  private readonly running = new Map<
    string,
    {
      readonly job: RunningAgentJob & { readonly startedAt: number };
      readonly controller: AbortController;
      /** `kill` was called: its exit is `cancelled`, whatever the run reports. */
      killed: boolean;
      /** Every sender's way in (`message`); it dies with the entry. */
      readonly inbox: AgentInbox;
      /** How many notifies this child sent since the user last wrote. */
      notified: number;
    }
  >();
  /**
   * Foreground children holding a slot: a token each, with its description for
   * the refusal, when it started, and what would move it to the background.
   */
  private readonly foreground = new Map<
    symbol,
    {
      readonly description: string;
      readonly startedAt: number;
      move?: () => void;
      readonly inbox: AgentInbox;
    }
  >();
  private readonly listeners = new Set<(exit: AgentJobExit) => void>();
  /** The parent Agent's subscriptions: a child's `agent_notify` reaches it here. */
  private readonly notifyListeners = new Set<(notify: AgentNotify) => void>();
  /** Waking notifies left before the next user message (`AGENT_NOTIFY_WAKES`). */
  private notifyWakesLeft = AGENT_NOTIFY_WAKES;
  /** Told after every visible change to `rows()` (a start, a progress, an end). */
  private readonly changeListeners = new Set<() => void>();
  /** Per child, the visible state folded from its progress events. */
  private readonly live = new Map<string, AgentJobLive>();
  /**
   * `subagents.twoWay`: a text handed to a child ends with one hint that it may
   * answer with `agent_notify` (docs/fix/autoaccept-wake-turns.md owner Q3 b).
   * Off → the delivered text is byte-identical to what it was.
   */
  private twoWay = false;

  constructor(maxParallel: number) {
    this.cap = maxParallel;
  }

  /** A settings sync changed `subagents.maxParallel`. Kills nothing; new work sees it. */
  setCap(maxParallel: number): void {
    this.cap = maxParallel;
  }

  /**
   * A settings sync changed `subagents.twoWay`: from now on a text handed to a
   * child carries the reply hint (or stops carrying it). Messages already queued
   * keep the shape they were pushed with.
   */
  setTwoWay(twoWay: boolean): void {
    this.twoWay = twoWay;
  }

  /**
   * The cap in force right now (`subagents.maxParallel`): what a refusal names
   * and what `agent_control` reports (`action: "status"`), so a settings sync is
   * reflected at once.
   */
  get limit(): number {
    return this.cap;
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

  /** Subscribe to a change of `rows()`; the caller re-reads it. Never awaited. */
  onChange(listener: () => void): () => void {
    this.changeListeners.add(listener);
    return () => this.changeListeners.delete(listener);
  }

  /**
   * The children running now, in launch order, with what they have done so far.
   * A child that ended has no row: this is the live state, not a history.
   */
  rows(): readonly AgentJobRow[] {
    return [...this.running.values()].map(({ job, inbox }) => {
      const live = this.live.get(job.agentId);
      return {
        id: job.agentId,
        callId: job.callId,
        agentType: job.agentType,
        description: job.description,
        state: "running",
        toolUses: live?.toolUses ?? 0,
        tokens: live?.tokens ?? 0,
        startedAt: job.startedAt,
        tail: live?.tail ?? [],
        userRead: inbox.read("user"),
        ...(live?.model !== undefined ? { model: live.model } : {}),
        ...(live?.modelId !== undefined ? { modelId: live.modelId } : {}),
      };
    });
  }

  /**
   * Fold one progress event of `agentId` into its row (`agent_task`'s closure
   * passes them on from the child's run). An unknown or ended id is a no-op;
   * a throwing listener never escapes to the child's run (Bun exits on an
   * unhandled rejection).
   */
  progress(agentId: string, event: ToolProgressEvent): void {
    const live = this.live.get(agentId);
    if (live === undefined || !this.running.has(agentId)) {
      return;
    }
    if (!foldAgentProgress(live, event)) {
      // `subagent_start` (already known) and `subagent_end` (the exit follows).
      return;
    }
    this.changed();
  }

  /**
   * Turn every FOREGROUND child into a background one, in one synchronous
   * stretch (docs/feat/subagent-detach.md: a person wrote while they run).
   * Idempotent — a moved child has left `foreground` — and each `move` runs in
   * its own `try`: a child that cannot move never takes the others down.
   */
  detachForeground(): void {
    for (const entry of [...this.foreground.values()]) {
      try {
        entry.move?.();
      } catch {
        // The child stays foreground and the steer is queued: nothing half-moved.
      }
    }
  }

  /**
   * Stop one child (owner Q1 a). True if it was running. Its run is aborted with
   * the child's own signal; its exit reports `cancelled`, whichever end the run
   * names (`kill` is a decision, not a report).
   */
  kill(agentId: string): boolean {
    const entry = this.running.get(agentId);
    // Already killed (its run has not settled yet): it is not running any more.
    if (entry === undefined || entry.killed) {
      return false;
    }
    entry.killed = true;
    entry.controller.abort();
    return true;
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
    const inbox = this.inbox();
    this.running.set(agentId, {
      job: {
        ...spec,
        agentId,
        ...(host.now ? { startedAt: host.now() } : { startedAt: 0 }),
      },
      controller,
      killed: false,
      inbox,
      notified: 0,
    });
    this.live.set(agentId, { toolUses: 0, tokens: 0, tail: [] });
    this.changed();
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
    const inbox = this.inbox();
    this.foreground.set(token, {
      description,
      startedAt: this.host?.now?.() ?? 0,
      inbox,
    });
    return {
      ok: true,
      release: () => void this.foreground.delete(token),
      inbox,
      movable: (move) => {
        const entry = this.foreground.get(token);
        if (entry !== undefined) {
          entry.move = move;
        }
      },
      adopt: (spec, controller, seed, run) => {
        const entry = this.foreground.get(token);
        const host = this.host;
        if (this.disposed || host === undefined || entry === undefined) {
          return undefined;
        }
        // A child that already stopped reading is not worth moving: the entry
        // would accept texts nobody reads (docs/feat/agent-message.md Design 2).
        if (entry.inbox.closed) {
          return undefined;
        }
        // FIRST: a throw here (the log refused) leaves the child foreground.
        const agentId = host.launched(spec);
        this.foreground.delete(token);
        this.running.set(agentId, {
          job: { ...spec, agentId, startedAt: entry.startedAt },
          controller,
          killed: false,
          inbox: entry.inbox,
          notified: 0,
        });
        this.live.set(agentId, seed);
        this.changed();
        // Same last net as `start`: nothing `drive` throws escapes as unhandled.
        void this.drive(agentId, spec, controller, run).catch(() => {});
        return agentId;
      },
    };
  }

  /**
   * Write one text into a RUNNING background child's context (docs/feat/agent-message.md):
   * THE seam every sender uses (`agent_control{action:"message"}`, the panel).
   * Synchronous end to end and never throwing: the check and the push happen in
   * one stretch, so a text it accepts is drained by the child at its next
   * boundary or reported by it — never accepted and then lost.
   *
   * No `changed()` here: a message changes no row. The READ does — the inbox's
   * `onRead` runs when the child takes it, and that is when the row's `userRead`
   * moves (docs/fix/autoaccept-wake-turns.md).
   */
  message(agentId: string, text: string, from: AgentMessageSender): AgentMessageResult {
    const entry = this.running.get(agentId);
    if (entry === undefined) {
      return {
        ok: false,
        reason: `${agentId} is not a running background sub-agent (it finished, was stopped, or never existed): nothing was sent.`,
      };
    }
    if (entry.killed) {
      return { ok: false, reason: `${agentId} is being stopped: nothing was sent.` };
    }
    if (text.length > AGENT_MESSAGE_MAX_CHARS) {
      return {
        ok: false,
        reason: `the message is ${text.length} characters, over the ${AGENT_MESSAGE_MAX_CHARS}-character limit: nothing was sent. Send a shorter one.`,
      };
    }
    const pushed = entry.inbox.push(inboxText(from, text, this.twoWay), from);
    if (pushed.ok) {
      return { ok: true, index: pushed.index };
    }
    return pushed.reason === "closed"
      ? {
          ok: false,
          reason: `${agentId} is finishing and can no longer read messages: nothing was sent. Its report arrives as a [background] note.`,
        }
      : {
          ok: false,
          reason: `${agentId} already has ${AGENT_INBOX_MAX} unread messages: nothing was sent. Wait for it to read them or for its report.`,
        };
  }

  /**
   * How many parent texts (`agent_control{action:"message"}`) `agentId` has
   * queued and not yet drained (docs/feat/agent-status.md). `0` for an id that
   * is not running: the count is the inbox's own, never a second counter.
   */
  pending(agentId: string): number {
    return this.running.get(agentId)?.inbox.pending ?? 0;
  }

  /**
   * A running background child speaks to the PARENT AGENT
   * (docs/feat/agent-message-two-way.md): the one source of truth for both
   * budgets, synchronous and never throwing, like `message`. Every accepted
   * note reaches every listener in the same stretch, so a note it accepts is
   * queued in the parent's exit queue before the child's tool returns.
   *
   * Over the WAKE budget the note is still accepted (`wakes: false`): the
   * parent reads it at its next step, it just asks for no continuation. Over
   * the per-child cap, or with no parent listening, nothing is sent and the
   * child is told — never a silent drop.
   */
  notify(agentId: string, text: string): AgentNotifyResult {
    const entry = this.running.get(agentId);
    if (entry === undefined) {
      return {
        ok: false,
        reason: `${agentId} is not a running background sub-agent (it finished, was stopped, or never existed): nothing was sent.`,
      };
    }
    if (entry.killed) {
      return { ok: false, reason: `${agentId} is being stopped: nothing was sent.` };
    }
    if (text.length > AGENT_MESSAGE_MAX_CHARS) {
      return {
        ok: false,
        reason: `the message is ${text.length} characters, over the ${AGENT_MESSAGE_MAX_CHARS}-character limit: nothing was sent. Send a shorter one.`,
      };
    }
    if (this.notifyListeners.size === 0) {
      // An agent that nobody listens for would swallow the text: the child must
      // learn to put it in its report instead.
      return {
        ok: false,
        reason: "no parent agent is listening: nothing was sent. Put it in your final report.",
      };
    }
    if (entry.notified >= AGENT_NOTIFY_PER_CHILD) {
      return {
        ok: false,
        reason: `you already sent ${AGENT_NOTIFY_PER_CHILD} messages to the parent agent since the user last wrote: nothing was sent. Put the rest in your final report.`,
      };
    }
    entry.notified += 1;
    const wakes = this.notifyWakesLeft > 0;
    if (wakes) {
      this.notifyWakesLeft -= 1;
    }
    const note: AgentNotify = {
      agentId,
      description: entry.job.description,
      text,
      wakes,
    };
    for (const listener of [...this.notifyListeners]) {
      try {
        listener(note);
      } catch {
        // A throwing listener never loses the others.
      }
    }
    return { ok: true, wakes };
  }

  /** Subscribe to the running children's notifies; returns an unsubscribe. */
  onNotify(listener: (notify: AgentNotify) => void): () => void {
    this.notifyListeners.add(listener);
    return () => this.notifyListeners.delete(listener);
  }

  /**
   * A user message reached the parent agent: both budgets start over
   * (docs/feat/agent-message-two-way.md). A parent's own message call never
   * resets them, so ping-pong stays bounded until the person writes.
   */
  userMessage(): void {
    this.notifyWakesLeft = AGENT_NOTIFY_WAKES;
    for (const entry of this.running.values()) {
      entry.notified = 0;
    }
  }

  /** Aborts every child. No `ended`, no exit: the session is going away. */
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.notifyListeners.clear();
    this.notifyWakesLeft = AGENT_NOTIFY_WAKES;
    this.changeListeners.clear();
    for (const { controller } of this.running.values()) {
      controller.abort();
    }
    this.running.clear();
    this.live.clear();
    this.foreground.clear();
  }

  /**
   * A child's inbox, wired to this registry's change listeners: the READ of a
   * message moves the row's `userRead`, so a frame must follow it
   * (docs/fix/autoaccept-wake-turns.md — without this, a drained text publishes
   * nothing and the drawer never says `✓ read`).
   */
  private inbox(): AgentInbox {
    return new AgentInbox({ onRead: () => this.changed() });
  }

  /** Tell every change listener, each in its own `try`: one bad sink loses no other. */
  private changed(): void {
    for (const listener of [...this.changeListeners]) {
      try {
        listener();
      } catch {
        // A client's render sink: a failure there is not the child's problem.
      }
    }
  }

  private used(): number {
    return this.running.size + this.foreground.size;
  }

  private descriptions(): readonly string[] {
    return [...this.foreground.values()].map((entry) => entry.description);
  }

  private refusal(): string {
    const named = [
      ...this.list().map((job) => `${job.agentId} (${job.description})`),
      ...this.descriptions().map((description) => `(foreground) ${description}`),
    ];
    // "End your turn and be woken" is only true when a background child runs:
    // foreground holders alone wake nobody, so ending the turn would stall the task.
    // `agent_control` is offered for the same reason (it stops a CHILD, never a
    // foreground call the model made itself): only when one is running.
    const next =
      this.running.size > 0
        ? `Either end your turn (you are woken by a [background] note when a background sub-agent finishes), or stop one with agent_control (action "kill"), or do this work yourself.`
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
    const inbox = this.running.get(agentId)?.inbox;
    let result: AgentJobResult;
    try {
      result = await run({
        signal: controller.signal,
        agentId,
        // The entry always exists here (both paths set it before `drive`), so the
        // inbox the child drains is the one `message` finds. A disposed runtime
        // never runs anything; the fallback is unreachable, kept for the type.
        inbox: inbox ?? this.inbox(),
      });
    } catch (error) {
      result = {
        report: `the sub-agent failed: ${error instanceof Error ? error.message : String(error)}`,
        toolUses: 0,
        stopReason: "error",
      };
    }
    const killed = this.running.get(agentId)?.killed === true;
    this.running.delete(agentId);
    this.live.delete(agentId);
    // The row is gone before anything can throw: the list is never stale.
    this.changed();
    if (this.disposed) {
      return;
    }
    // `kill` is a decision, not a report: a killed child ended `cancelled`
    // whatever its run said (a child that noticed its signal may say `end_turn`).
    const stopReason = killed ? "cancelled" : result.stopReason;
    const report = capSubagentText(
      result.report.trim() === "" ? NO_OUTPUT : result.report,
      SUBAGENT_REPORT_MAX_CHARS,
    );
    try {
      this.host?.ended(agentId, stopReason, report);
    } catch {
      // Durability is lost, but the live note and the wake still go out: the
      // listeners below run unconditionally, and nothing is left rejected.
    }
    const exit: AgentJobExit = { ...spec, agentId, ...result, stopReason, report };
    for (const listener of [...this.listeners]) {
      try {
        listener(exit);
      } catch {
        // A throwing listener never loses the others.
      }
    }
  }
}
