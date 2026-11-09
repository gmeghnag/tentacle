import {
  type KnownLogEntry,
  SUBAGENT_AGENT_TYPE_MAX_CHARS,
  SUBAGENT_CALL_ID_MAX_CHARS,
  SUBAGENT_DESCRIPTION_MAX_CHARS,
  SUBAGENT_REPORT_MAX_CHARS,
  SUBAGENT_STOP_REASON_MAX_CHARS,
} from "@tentacle/protocol";
/**
 * The persistence contract of a background sub-agent
 * (docs/feat/subagent-ledger-log.md) — a pure, React-free, IO-free,
 * clock-free state machine over its DURABLE facts.
 *
 * A background child outlives its `agent_task` call (task 6a): its report
 * re-enters later as a user-role note, like a shell job's exit. Two things
 * must survive a restart: that it EXISTS (a compaction / `context_reset` may
 * drop the `started in background as sa-N` tool result), and that it ENDED
 * with a report that was never delivered. So the daemon logs two NON-critical
 * markers (`subagent_background`, `subagent_end`), and this ledger is the ONE
 * set of transitions that both the LIVE path (6a) and the REPLAY (a load) use:
 * anything else is two rules that drift.
 *
 * Load-bearing property: the markers never travel past a segment start, the
 * NOTE does. A note in the messages closes its id by itself, for every later
 * load, which makes `subagentLoadNotes` idempotent — the load writes nothing,
 * it only returns what to append.
 */
import type { ChatMessage, MessageNote } from "./model.ts";
import { NOTE_KIND } from "./model.ts";

/** A background sub-agent's durable facts. `state`: still running, or ended (its report may be empty). */
export interface AgentJob {
  readonly agentId: string;
  readonly callId: string;
  readonly agentType: string;
  readonly description: string;
  readonly state: "running" | "ended";
  readonly stopReason?: string;
  /** Capped by `end` (head + tail + a cut line): a log never holds a value a reader must refuse. */
  readonly report?: string;
}

/** What a `subagent_background` entry carries (the payload, without its envelope). */
export type SubagentBackgroundBody = Extract<
  KnownLogEntry,
  { type: "subagent_background" }
> extends infer E
  ? E extends KnownLogEntry
    ? Omit<E, "type" | "seq" | "id" | "prev" | "ts" | "critical">
    : never
  : never;

/** What a `subagent_end` entry carries (the payload, without its envelope). */
export type SubagentEndBody = Extract<KnownLogEntry, { type: "subagent_end" }> extends infer E
  ? E extends KnownLogEntry
    ? Omit<E, "type" | "seq" | "id" | "prev" | "ts" | "critical">
    : never
  : never;

/** The id prefix of a background sub-agent: `sa-1`, `sa-2`, … */
export const AGENT_ID_PREFIX = "sa-";
/** Matches an id anywhere in a text (`started in background as sa-3: …`). */
const AGENT_ID_IN_TEXT = /\bsa-(\d+)\b/g;

/**
 * Cap `text` at `max` chars, keeping the head and the tail and saying how much
 * was cut: a truncated report stays useful (its conclusion is usually at the
 * end) and is never silently shortened.
 */
export function capSubagentText(text: string, max: number): string {
  if (text.length <= max) {
    return text;
  }
  const cut = text.length - max;
  const marker = `\n[… ${cut} chars cut]\n`;
  const room = Math.max(0, max - marker.length);
  const head = Math.ceil(room * 0.7);
  const tail = room - head;
  return `${text.slice(0, head)}${marker}${tail > 0 ? text.slice(text.length - tail) : ""}`;
}

/**
 * Cap a short identifying string (never `capText`: a cut line inside an
 * `agentType`/`callId`/`stopReason` is noise, not a report). `""` → `"unknown"`,
 * because those fields are `min(1)` in the schema (review M4).
 */
function bounded(text: string, max: number): string {
  return text === "" ? "unknown" : text.slice(0, max);
}

/**
 * The state machine of the background sub-agents this session knows: the
 * `sa-N` counter, the live jobs, and the set re-emitted at a segment start.
 */
export class AgentJobLedger {
  /** Insertion order is the emission order (bg order; an `end` without its `bg` joins at its own end). */
  private readonly jobs = new Map<string, AgentJob>();
  /**
   * The ids a note already DELIVERED (or that `fromHistory` saw delivered): a
   * later `background`/`end` for one of them is a duplicate or a late arrival and
   * returns `null`. Without it, a delivered child that leaves the current segment
   * (a compaction) is re-noted at the next load, with a contradictory report
   * (review M1, FM 7 "first wins").
   */
  private readonly closed = new Set<string>();
  private counter = 0;

  /**
   * Seed the counter from a history: `1 + the highest N` of any `note.id` of
   * the form `sa-N` AND of any `sa-N` in a message's content — so a restarted
   * session never hands out an id the model has already seen (the
   * `started in background as sa-N` tool result may be the only trace).
   */
  static fromHistory(messages: readonly ChatMessage[]): AgentJobLedger {
    const ledger = new AgentJobLedger();
    const consider = (text: string): void => {
      for (const match of text.matchAll(AGENT_ID_IN_TEXT)) {
        const digits = match[1];
        if (digits !== undefined) {
          ledger.reserve(digits);
        }
      }
    };
    for (const message of messages) {
      const note = message.note;
      const id = note?.id;
      if (note !== undefined && id !== undefined) {
        const exact = /^sa-(\d+)$/.exec(id);
        if (exact?.[1] !== undefined) {
          ledger.reserve(exact[1]);
        }
        // What a note of a sub-agent kind names is DELIVERED: a reload remembers
        // it, so a replayed or late `end` never notes the child a second time.
        if (note.kind === NOTE_KIND.subagentReport || note.kind === NOTE_KIND.subagentLost) {
          ledger.closed.add(id);
        }
      }
      consider(message.content);
    }
    return ledger;
  }

  /** The next free id (`sa-N`, never reused). */
  nextId(): string {
    this.counter++;
    return `${AGENT_ID_PREFIX}${this.counter}`;
  }

  /**
   * A child started in the background: its `subagent_background` payload, or
   * `null` when the id is already known (a duplicate replay: first wins).
   */
  background(job: {
    readonly agentId: string;
    readonly callId: string;
    readonly agentType: string;
    readonly description: string;
  }): SubagentBackgroundBody | null {
    if (this.closed.has(job.agentId) || this.jobs.has(job.agentId)) {
      return null;
    }
    const running: AgentJob = {
      agentId: job.agentId,
      callId: bounded(job.callId, SUBAGENT_CALL_ID_MAX_CHARS),
      agentType: bounded(job.agentType, SUBAGENT_AGENT_TYPE_MAX_CHARS),
      description: capSubagentText(job.description, SUBAGENT_DESCRIPTION_MAX_CHARS),
      state: "running",
    };
    this.jobs.set(running.agentId, running);
    this.reserveNumeric(running.agentId);
    return {
      agentId: running.agentId,
      callId: running.callId,
      agentType: running.agentType,
      description: running.description,
    };
  }

  /**
   * A child ended: its `subagent_end` payload, or `null` when the id is
   * unknown (`end` without its `bg`) or already ended (a duplicate or late
   * end: the FIRST one wins, and a running→ended transition happens once).
   * `report` is capped here, by the emitter, so a reader never refuses it.
   */
  end(
    agentId: string,
    stopReason: string,
    report?: string,
    opts: { readonly orphan?: boolean } = {},
  ): SubagentEndBody | null {
    if (this.closed.has(agentId)) {
      return null;
    }
    const job = this.jobs.get(agentId);
    if (job === undefined) {
      // A LIVE `end` for an id this session never started is nothing to keep: a
      // marker for it would be re-emitted forever and carry no work product.
      if (opts.orphan !== true) {
        return null;
      }
      // An `end` whose `bg` is gone (a superseded segment): keep the fact, with
      // no description — a work product is never dropped for a missing pair.
      const reason = bounded(stopReason, SUBAGENT_STOP_REASON_MAX_CHARS);
      const orphan: AgentJob = {
        agentId,
        callId: "",
        agentType: "",
        description: "",
        state: "ended",
        stopReason: reason,
        ...(report !== undefined
          ? { report: capSubagentText(report, SUBAGENT_REPORT_MAX_CHARS) }
          : {}),
      };
      this.jobs.set(agentId, orphan);
      this.reserveNumeric(agentId);
      return {
        agentId,
        stopReason: reason,
        ...(orphan.report !== undefined ? { report: orphan.report } : {}),
      };
    }
    if (job.state === "ended") {
      return null;
    }
    const reason = bounded(stopReason, SUBAGENT_STOP_REASON_MAX_CHARS);
    const capped =
      report !== undefined ? capSubagentText(report, SUBAGENT_REPORT_MAX_CHARS) : undefined;
    this.jobs.set(agentId, {
      ...job,
      state: "ended",
      stopReason: reason,
      ...(capped !== undefined ? { report: capped } : {}),
    });
    return { agentId, stopReason: reason, ...(capped !== undefined ? { report: capped } : {}) };
  }

  /**
   * A note is now IN the history: its id is delivered, so the job leaves the
   * ledger (a note closes exactly what it names). Kinds without an id, or a
   * kind that is not about a sub-agent, change nothing.
   */
  noteSeen(note: MessageNote): void {
    if (note.id === undefined) {
      return;
    }
    if (note.kind !== NOTE_KIND.subagentReport && note.kind !== NOTE_KIND.subagentLost) {
      return;
    }
    this.jobs.delete(note.id);
    this.closed.add(note.id);
  }

  /**
   * The markers a segment start re-emits: `[bg]` for a running child, `[bg,
   * end]` for one that ended undelivered (a load or a `context_reset` may drop
   * the tool result; the facts must not go with it). Delivered → nothing.
   */
  segmentFacts(): (SubagentBackgroundBody | SubagentEndBody)[] {
    const out: (SubagentBackgroundBody | SubagentEndBody)[] = [];
    for (const job of this.jobs.values()) {
      // An ORPHAN (an `end` whose `bg` is gone, FM 5) has no `callId`/`agentType`:
      // re-emitting a `subagent_background` for it would fail that schema
      // (`callId` min 1) and a reader would refuse the whole log. Its `end`
      // alone is what the load reads.
      if (job.callId !== "") {
        out.push({
          agentId: job.agentId,
          callId: job.callId,
          agentType: job.agentType,
          description: job.description,
        });
      }
      if (job.state === "ended" && job.stopReason !== undefined) {
        out.push({
          agentId: job.agentId,
          stopReason: job.stopReason,
          ...(job.report !== undefined ? { report: job.report } : {}),
        });
      }
    }
    return out;
  }

  /** The children still running (6a's liveness, the quit count, a hand-over). */
  running(): readonly AgentJob[] {
    return [...this.jobs.values()].filter((job) => job.state === "running");
  }

  /** Every child still in the ledger (running, or ended and not yet delivered). */
  handOver(): AgentJob[] {
    const out = [...this.jobs.values()];
    this.jobs.clear();
    return out;
  }

  /** Take jobs over from another session; an adopted id stays reserved (`nextId` never reuses it). */
  adopt(jobs: readonly AgentJob[]): void {
    for (const job of jobs) {
      if (!this.jobs.has(job.agentId)) {
        this.jobs.set(job.agentId, job);
      }
      this.reserveNumeric(job.agentId);
    }
  }

  /** Every child still open, as the note a load appends (in ledger insertion order). */
  loadNotes(): ChatMessage[] {
    const out: ChatMessage[] = [];
    for (const job of this.jobs.values()) {
      out.push(job.state === "running" ? subagentLostNote(job) : subagentReportNote(job));
    }
    return out;
  }

  /** Keep the counter ahead of a numeric id this ledger has seen. */
  private reserveNumeric(agentId: string): void {
    const match = /^sa-(\d+)$/.exec(agentId);
    if (match?.[1] !== undefined) {
      this.reserve(match[1]);
    }
  }

  private reserve(digits: string): void {
    const n = Number(digits);
    if (Number.isSafeInteger(n) && n > this.counter) {
      this.counter = n;
    }
  }
}

/** `sa-3 (map the repo)` — the parenthesised description, when there is one. */
function subjectOf(job: AgentJob): string {
  return job.description === "" ? job.agentId : `${job.agentId} (${job.description})`;
}

/**
 * The note a lost child leaves (user role, model-visible): the restart killed
 * it, so its work product is gone and its side effects may not be.
 */
export function subagentLostNote(job: AgentJob): ChatMessage {
  return {
    role: "user",
    content: `[background] sub-agent ${subjectOf(job)} was lost: the session restarted before it finished. Its partial work may have had side effects; check before redoing it.`,
    note: { kind: NOTE_KIND.subagentLost, id: job.agentId },
  };
}

/**
 * The note a finished child leaves. 6a's LIVE exit note is built by this same
 * helper, so live and load read alike (`headline` differs only in the wording
 * before the report).
 */
export function subagentReportNote(job: AgentJob, headline?: string): ChatMessage {
  const stopped = job.stopReason !== undefined ? ` (${job.stopReason})` : "";
  const head =
    headline ??
    `[background] sub-agent ${subjectOf(job)} finished${stopped} before the session restarted:`;
  const content =
    job.report !== undefined && job.report !== ""
      ? `${head}\n${job.report}`
      : `[background] sub-agent ${subjectOf(job)} ended${stopped} before the session restarted; it left no report.`;
  return { role: "user", content, note: { kind: NOTE_KIND.subagentReport, id: job.agentId } };
}

/**
 * THE load derivation, shared by the laptop's load and the `serve` daemon's
 * reload (one rule, so the two cannot drift): replay the CURRENT segment's
 * `subagent_*` markers into a ledger, close the ids a note in `messages`
 * already names, and return what is still open as notes to APPEND.
 *
 * Idempotent by construction: the returned notes carry `note.id`, so the next
 * load (with them in `messages`) returns `[]`. Empty history / no markers →
 * `[]`.
 */
export function subagentLoadNotes(
  entries: readonly KnownLogEntry[],
  messages: readonly ChatMessage[],
): ChatMessage[] {
  const ledger = new AgentJobLedger();
  for (const entry of entries) {
    if (entry.type === "subagent_background") {
      ledger.background({
        agentId: entry.agentId,
        callId: entry.callId,
        agentType: entry.agentType,
        description: entry.description,
      });
    } else if (entry.type === "subagent_end") {
      // A replay is the ONE place an `end` without its `bg` is kept (FM 5): the
      // work product survives a segment boundary, the live path never invents one.
      ledger.end(entry.agentId, entry.stopReason, entry.report, { orphan: true });
    }
  }
  for (const message of messages) {
    if (message.note !== undefined) {
      ledger.noteSeen(message.note);
    }
  }
  return ledger.loadNotes();
}
