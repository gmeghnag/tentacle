/**
 * `tentacle logs`' ONE output vocabulary (docs/feat/logs-cmd.md): the events a
 * session's log entries become, plus how they are categorised (`--only`),
 * summarised and rendered. Pure — no IO, no clock, no React — so every rule is
 * testable here and `logs-cmd.ts` only finds a file and prints.
 *
 * Sub-task 1 is the ENTRY half (`--tail`, and the file-follow of owner Q4); the
 * UPDATE half (`-f` over the daemon's watcher) lands in sub-task 2, adding the
 * live-only types (`text`, `thought`, `ask`, `ask_resolved`, `lost`, `closed`).
 * `LOG_CATEGORIES` is already the ONE list of `--only` names both sources use:
 * sub-task 2's `WATCH_CATEGORIES` is the same set, and the daemon's filter and
 * this one must not drift.
 *
 * Untrusted text: a message, a tool result or a pod's arguments can carry
 * terminal escapes (AGENTS §7). The EVENT keeps the text (capped) so `--json`
 * stays lossless-but-escaped; TEXT mode sanitises at render time
 * (`untrustedText`), and `--json` escapes C1 too (U+0080–U+009F, which
 * `JSON.stringify` leaves raw). Tool arguments are a display SUMMARY: one line
 * by construction (`oneLine`), as the design says.
 */
import type { KnownLogEntry, SessionUpdate, WireChatMessage } from "@tentacle/protocol";
import { oneLine } from "@tentacle/tui";
import { untrustedText } from "./untrusted-text.ts";

/** The NDJSON shape's version (`--json` is a script contract): bumped on a breaking change. */
export const LOG_EVENT_VERSION = 1;
/** The most characters of a message's text one event carries. */
export const LOG_TEXT_MAX = 2000;
/** The most characters of a tool call's argument summary. */
export const LOG_ARGS_MAX = 200;
/** The most characters of a tool result's `head`. */
export const LOG_HEAD_MAX = 200;
/** The `--tail` default: the last N events. */
export const LOG_TAIL_DEFAULT = 20;
/** How often `-f` (the file fallback) re-reads the file. */
export const LOG_FOLLOW_INTERVAL_MS = 1000;

/**
 * The `--only` categories: the same names the daemon's watcher filters on
 * (`session/watch`, sub-task 2), so one word means one thing on both sources.
 */
export const LOG_CATEGORIES = [
  "ask",
  "turn",
  "error",
  "text",
  "thought",
  "tool",
  "subagent",
  "job",
  "history",
  "notice",
] as const;
export type LogCategory = (typeof LOG_CATEGORIES)[number];

/** Every event type this build emits: the entry half, then the live-only ones (`-f`). */
export type LogEventType =
  | "segment"
  | "turn_start"
  | "turn_end"
  | "user"
  | "assistant"
  | "tool_call"
  | "tool_result"
  | "call_started"
  | "title"
  | "subagent_start"
  | "subagent_end"
  | "notice"
  // Live only (`-f` over the daemon's watcher, sub-task 2): streamed text and
  // reasoning, the asks, and the follower's own facts (what it lost, why the
  // stream stopped). A log file never produces these.
  | "text"
  | "thought"
  | "ask"
  | "ask_resolved"
  | "lost"
  | "closed";

/** What every event carries: the shape's version, the daemon's clock, the session, the type. */
interface EventBase {
  readonly v: typeof LOG_EVENT_VERSION;
  /** The daemon's clock of the entry it came from (display only). */
  readonly ts: number;
  readonly session: string;
}

/** One event: the NDJSON object `--json` prints (and what the human line renders). */
export type LogEvent = EventBase &
  (
    | {
        readonly type: "segment";
        readonly reason: string;
        /** The incarnation a log file's `base` names; absent for a live barrier. */
        readonly inc?: string;
        /** The messages the file's `base` carried; absent for a live barrier. */
        readonly count?: number;
        readonly turn?: string;
      }
    | { readonly type: "turn_start"; readonly turnId: string }
    | {
        readonly type: "turn_end";
        readonly turnId: string;
        readonly stopReason: string;
        /** The turn's error, when it ended with one (live only: a log entry has no message). */
        readonly error?: string;
      }
    | { readonly type: "user"; readonly text: string; readonly chars: number }
    | { readonly type: "assistant"; readonly text: string; readonly chars: number }
    | { readonly type: "text"; readonly text: string; readonly chars: number }
    | { readonly type: "thought"; readonly text: string; readonly chars: number }
    | {
        readonly type: "ask";
        readonly requestId: string;
        readonly tool: string;
        readonly title: string;
        readonly options: readonly string[];
      }
    | { readonly type: "ask_resolved"; readonly requestId: string; readonly outcome: string }
    | { readonly type: "lost"; readonly count: number }
    | { readonly type: "closed"; readonly reason: string }
    | {
        readonly type: "tool_call";
        readonly callId: string;
        readonly name: string;
        readonly args: string;
      }
    | {
        readonly type: "tool_result";
        readonly callId: string;
        readonly chars: number;
        readonly head: string;
      }
    | { readonly type: "call_started"; readonly callId: string }
    | { readonly type: "title"; readonly text: string; readonly source: string }
    | {
        readonly type: "subagent_start";
        readonly agentId: string;
        readonly agentType: string;
        readonly description: string;
      }
    | { readonly type: "subagent_end"; readonly agentId: string; readonly stopReason: string }
    | { readonly type: "notice"; readonly text: string }
  );

/** The tools whose arguments name a file they touched (`--summary`'s `files`). */
export const FILE_TOOLS: readonly string[] = ["fs_write", "fs_edit", "fs_multi_edit"];

function cap(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** A tool call's arguments as one capped line (never raw escapes: it is display text). */
function argsSummary(raw: string): string {
  return cap(oneLine(raw), LOG_ARGS_MAX);
}

interface Projected {
  readonly ts: number;
  readonly message: WireChatMessage;
}

/**
 * The messages the entries project to, each with the `ts` of the entry that
 * introduced it (a `replace` updates the message, never its place or its time).
 * The same fold the session log's own reader applies, kept here so the events
 * never disagree with the history a resume sees.
 */
function projectMessages(entries: readonly KnownLogEntry[]): Projected[] {
  const projection: Projected[] = [];
  for (const entry of entries) {
    switch (entry.type) {
      case "base":
        projection.length = 0;
        break;
      case "message":
      case "media_message":
        projection.push({ ts: entry.ts, message: entry.message });
        break;
      case "replace":
      case "media_replace":
        if (entry.index < projection.length) {
          projection[entry.index] = { ts: entry.ts, message: entry.message };
        }
        break;
      case "truncate":
        if (entry.length < projection.length) {
          projection.length = entry.length;
        }
        break;
      default:
        break;
    }
  }
  return projection;
}

/** The events ONE message becomes: a text event where it has text, one per tool call. */
function messageEvents(ts: number, message: WireChatMessage, session: string): LogEvent[] {
  const base = { v: LOG_EVENT_VERSION, ts, session } as const;
  const text = typeof message.content === "string" ? message.content : "";
  switch (message.role) {
    case "system":
      return [{ ...base, type: "notice", text: cap(text, LOG_TEXT_MAX) }];
    case "user":
      return [{ ...base, type: "user", text: cap(text, LOG_TEXT_MAX), chars: text.length }];
    case "tool":
      return [
        {
          ...base,
          type: "tool_result",
          callId: message.toolCallId ?? "",
          chars: text.length,
          head: text.slice(0, LOG_HEAD_MAX),
        },
      ];
    case "assistant": {
      const events: LogEvent[] = [];
      if (text !== "") {
        events.push({
          ...base,
          type: "assistant",
          text: cap(text, LOG_TEXT_MAX),
          chars: text.length,
        });
      }
      for (const call of message.toolCalls ?? []) {
        events.push({
          ...base,
          type: "tool_call",
          callId: call.id,
          name: call.name,
          args: argsSummary(call.arguments),
        });
      }
      return events;
    }
  }
}

/** A marker entry's event, or none (a `checkpoint` is a derivation fact, not an event). */
function markEvent(entry: KnownLogEntry, session: string): LogEvent | undefined {
  const base = { v: LOG_EVENT_VERSION, ts: entry.ts, session } as const;
  switch (entry.type) {
    case "base":
      return {
        ...base,
        type: "segment",
        reason: entry.reason,
        inc: entry.inc,
        count: entry.count,
        ...(entry.turn !== undefined ? { turn: entry.turn } : {}),
      };
    case "turn_start":
      return { ...base, type: "turn_start", turnId: entry.turnId };
    case "turn_end":
      return { ...base, type: "turn_end", turnId: entry.turnId, stopReason: entry.stopReason };
    case "title":
      return { ...base, type: "title", text: entry.title.text, source: entry.title.source };
    case "call_started":
      return { ...base, type: "call_started", callId: entry.callId };
    case "subagent_background":
      return {
        ...base,
        type: "subagent_start",
        agentId: entry.agentId,
        agentType: entry.agentType,
        description: entry.description,
      };
    case "subagent_end":
      return {
        ...base,
        type: "subagent_end",
        agentId: entry.agentId,
        stopReason: entry.stopReason,
      };
    default:
      return undefined;
  }
}

/**
 * The events of a log's entries, in log order: the messages of the projection
 * (as a resume sees them) where they sit, with every marker between them. Two
 * passes, because a `replace`/`truncate` edits the projection while the marker
 * beside it keeps its place: pass one folds the projection and remembers each
 * marker's position (how many messages preceded it), pass two emits.
 * `session` is the uid (the NDJSON `session` field).
 */
export function eventsOf(entries: readonly KnownLogEntry[], session: string): LogEvent[] {
  const projected = projectMessages(entries);
  const marks: { readonly at: number; readonly event: LogEvent }[] = [];
  let at = 0;
  for (const entry of entries) {
    if (entry.type === "base") {
      at = 0;
    } else if (entry.type === "message" || entry.type === "media_message") {
      at++;
    } else if (entry.type === "truncate") {
      if (entry.length < at) at = entry.length;
    }
    const event = markEvent(entry, session);
    if (event !== undefined) {
      marks.push({ at, event });
    }
  }
  const out: LogEvent[] = [];
  let next = 0;
  const flush = (upTo: number): void => {
    while (next < marks.length && (marks[next]?.at ?? 0) <= upTo) {
      const mark = marks[next];
      if (mark !== undefined) out.push(mark.event);
      next++;
    }
  };
  for (let i = 0; i < projected.length; i++) {
    flush(i);
    const item = projected[i];
    if (item !== undefined) out.push(...messageEvents(item.ts, item.message, session));
  }
  flush(Number.POSITIVE_INFINITY);
  return out;
}

/**
 * The events ONE live UPDATE becomes (sub-task 2's half of the ONE vocabulary,
 * `-f` over the daemon's watcher). `ts` is THIS client's clock: a live update
 * carries the daemon's `seq`, not a time, and the arrival time is what a
 * follower's line needs. `[]` for an update that is not a line of its own (a
 * plan, a usage meter, a queue state: a follower watching a stream does not
 * want one line each) — they are folded into nothing, and `--only notice` does
 * not resurrect them (their content is in the turn's own lines).
 */
export function updateEvents(update: SessionUpdate, session: string, ts: number): LogEvent[] {
  const base = { v: LOG_EVENT_VERSION, ts, session } as const;
  switch (update.type) {
    case "turn_start":
      return [{ ...base, type: "turn_start", turnId: update.turnId }];
    case "turn_end":
      return [
        {
          ...base,
          type: "turn_end",
          turnId: update.turnId,
          stopReason: update.stopReason,
          ...(update.error !== undefined ? { error: update.error.message } : {}),
        },
      ];
    case "agent_message_chunk": {
      const text = chunkText(update.content);
      return text === ""
        ? []
        : [{ ...base, type: "text", text: cap(text, LOG_TEXT_MAX), chars: text.length }];
    }
    case "agent_thought_chunk": {
      const text = chunkText(update.content);
      return text === ""
        ? []
        : [{ ...base, type: "thought", text: cap(text, LOG_TEXT_MAX), chars: text.length }];
    }
    case "permission_request":
      return [
        {
          ...base,
          type: "ask",
          requestId: update.requestId,
          tool: update.tool,
          title: update.title,
          options: update.options.map((option) => option.name),
        },
      ];
    // A remote agent's question (docs/feat/a2a-client.md C6): an ask answered
    // with text (`session/answer_question`) or skipped.
    case "question_request":
      return [
        {
          ...base,
          type: "ask",
          requestId: update.requestId,
          tool: update.agent?.type ?? "question",
          title: update.title,
          options: ["Answer…", "Skip"],
        },
      ];
    case "permission_resolved":
      return [
        {
          ...base,
          type: "ask_resolved",
          requestId: update.requestId,
          outcome:
            update.outcome.outcome === "selected"
              ? `selected ${update.outcome.optionId}`
              : "cancelled",
        },
      ];
    case "tool_call":
      return [
        {
          ...base,
          type: "tool_call",
          callId: update.toolCallId,
          name: update.title,
          args: argsSummary(JSON.stringify(update.rawInput ?? {})),
        },
      ];
    case "tool_call_update": {
      const text = (update.content ?? [])
        .map((block) => chunkText(block))
        .filter((part) => part !== "")
        .join("\n");
      return [
        {
          ...base,
          type: "tool_result",
          callId: update.toolCallId,
          chars: text.length,
          head: text.slice(0, LOG_HEAD_MAX),
        },
      ];
    }
    case "tool_call_phase":
      return update.phase === "running"
        ? [{ ...base, type: "call_started", callId: update.toolCallId }]
        : [];
    case "tool_progress":
      return progressEvent(update, base);
    case "session_title":
      return [{ ...base, type: "title", text: update.title, source: update.source }];
    case "history_replaced":
      // A live barrier: the follower says the history was replaced, no count.
      return [{ ...base, type: "segment", reason: update.reason }];
    case "session_closed":
      return [{ ...base, type: "closed", reason: update.reason }];
    case "background_exit":
      return [
        {
          ...base,
          type: "notice",
          text: `job ${update.jobId} ${update.status}${update.exitCode !== null ? ` (exit ${update.exitCode})` : ""}`,
        },
      ];
    case "subagent_notify":
      return [{ ...base, type: "notice", text: `subagent ${update.agentId}: ${update.text}` }];
    case "subagent_message":
      return [{ ...base, type: "notice", text: `to subagent ${update.agentId}: ${update.text}` }];
    case "context_note":
    case "dsml_leak":
      return [{ ...base, type: "notice", text: update.text }];
    case "truncated_reply":
      return [
        {
          ...base,
          type: "notice",
          text:
            update.reason === "length"
              ? `reply cut (output limit)${update.retrying === true ? "; re-asking" : ""}`
              : "reply cut (no stop reason)",
        },
      ];
    case "empty_turn":
      return [{ ...base, type: "notice", text: "the turn produced nothing" }];
    case "history_repaired":
      return [
        {
          ...base,
          type: "notice",
          text: `history repaired (${update.invalidArguments} invalid args, ${update.unansweredCalls} unanswered calls)`,
        },
      ];
    // Folded, never a line of their own: the full lists (subagents, jobs), the
    // queue, the settings report, the plan, the usage meter. Each is state a
    // follower's line-per-event vocabulary has no question for, and their facts
    // arrive in the turn's own events (`--summary` reads a FILE, not a stream).
    default:
      return [];
  }
}

/** The text of a content block (an image or a resource is named, never dumped). */
function chunkText(block: {
  readonly type: string;
  readonly text?: string;
  readonly uri?: string;
}): string {
  if (block.type === "text") {
    return block.text ?? "";
  }
  return block.type === "image" ? "[image]" : `[resource ${block.uri ?? ""}]`;
}

/** A tool's live label (`subagent_start`/`subagent_end`/`subagent_tool`): one line each. */
function progressEvent(
  update: Extract<SessionUpdate, { type: "tool_progress" }>,
  base: { readonly v: typeof LOG_EVENT_VERSION; readonly ts: number; readonly session: string },
): LogEvent[] {
  switch (update.kind) {
    case "subagent_start":
      return [
        {
          ...base,
          type: "subagent_start",
          agentId: update.toolCallId,
          agentType: update.agentType ?? "",
          description: update.description ?? "",
        },
      ];
    case "subagent_end":
      return [
        {
          ...base,
          type: "subagent_end",
          agentId: update.toolCallId,
          stopReason: update.stopReason ?? "",
        },
      ];
    default:
      return update.label === undefined
        ? []
        : [{ ...base, type: "notice", text: `${update.kind}: ${update.label}` }];
  }
}

/** The categories an event belongs to (`--only`); `error` also covers a failed turn's end. */
export function categoriesOf(event: LogEvent): readonly LogCategory[] {
  switch (event.type) {
    case "turn_start":
      return ["turn"];
    case "turn_end":
      return event.stopReason === "error" ? ["turn", "error"] : ["turn"];
    case "closed":
      // The stream stopped: that IS the error a follower waits for (the same
      // rule as the daemon's `session_closed` -> `error`), and it ends the turn
      // that was running, so both words reach it.
      return ["error"];
    case "user":
    case "assistant":
    case "text":
      return ["text"];
    case "thought":
      return ["thought"];
    case "ask":
    case "ask_resolved":
      return ["ask"];
    case "tool_call":
    case "tool_result":
    case "call_started":
      return ["tool"];
    case "subagent_start":
    case "subagent_end":
      return ["subagent"];
    case "segment":
      return ["history"];
    // A drop notice is the follower's own fact about the stream: it belongs to
    // every filter (silently losing it is the bug owner Q3 forbids).
    case "lost":
      return [...LOG_CATEGORIES];
    case "title":
    case "notice":
      return ["notice"];
  }
}

export type OnlyResult =
  | { readonly ok: true; readonly categories: readonly LogCategory[] }
  | { readonly ok: false; readonly error: string };

/** `--only ask,turn`: a comma-separated list of {@link LOG_CATEGORIES}. */
export function parseOnly(text: string): OnlyResult {
  const names = text
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "");
  if (names.length === 0) {
    return {
      ok: false,
      error: `--only needs at least one category (${LOG_CATEGORIES.join(", ")})`,
    };
  }
  const known = new Set<string>(LOG_CATEGORIES);
  const unknown = names.filter((name) => !known.has(name));
  if (unknown.length > 0) {
    return {
      ok: false,
      error: `unknown --only category ${unknown.map((n) => JSON.stringify(n)).join(", ")} (choose from ${LOG_CATEGORIES.join(", ")})`,
    };
  }
  return { ok: true, categories: [...new Set(names)] as LogCategory[] };
}

/** The events matching `--only` (no filter when absent). */
export function filterEvents(
  events: readonly LogEvent[],
  only: readonly LogCategory[] | undefined,
): LogEvent[] {
  if (only === undefined) {
    return [...events];
  }
  const wanted = new Set(only);
  return events.filter((event) => categoriesOf(event).some((category) => wanted.has(category)));
}

/** The last `count` events (`--tail 0` keeps none). */
export function takeLast<T>(events: readonly T[], count: number): T[] {
  if (count <= 0) {
    return [];
  }
  return events.slice(Math.max(0, events.length - count));
}

/** `HH:MM:SS` in local time; `ts` is the daemon's clock, display only. */
export function formatTime(ts: number): string {
  const date = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** One human line for an event (never more than one: every detail is sanitised). */
export function formatEvent(event: LogEvent): string {
  const at = formatTime(event.ts);
  switch (event.type) {
    case "segment":
      return `${at} · segment ${event.reason} (${event.count ?? 0} messages)`;
    case "turn_start":
      return `${at} · turn start ${event.turnId}`;
    case "turn_end":
      return `${at} · turn end ${event.turnId} — ${event.stopReason}${
        event.error !== undefined ? `: ${untrustedText(event.error)}` : ""
      }`;
    case "text":
      return `${at} · ${untrustedText(event.text)}`;
    case "thought":
      return `${at} · thought: ${untrustedText(event.text)}`;
    case "ask":
      return `${at} · ask ${event.requestId}: ${untrustedText(event.tool)} ${untrustedText(event.title)} [${event.options
        .map((option) => untrustedText(option))
        .join(", ")}]`;
    case "ask_resolved":
      return `${at} · ask ${event.requestId} ${untrustedText(event.outcome)}`;
    case "lost":
      return `${at} · lost ${event.count} event(s) (the daemon's queue overflowed; nothing else is missing)`;
    case "closed":
      return `${at} · closed (${untrustedText(event.reason)})`;
    case "user":
      return `${at} · you: ${untrustedText(event.text)}`;
    case "assistant":
      return `${at} · agent: ${untrustedText(event.text)}`;
    case "tool_call":
      return `${at} · tool ${untrustedText(event.name)} ${untrustedText(event.args)}`;
    case "tool_result":
      return `${at} · result ${event.chars} chars: ${untrustedText(event.head)}`;
    case "call_started":
      return `${at} · call ${event.callId} started`;
    case "title":
      return `${at} · title: ${untrustedText(event.text)}`;
    case "subagent_start":
      return `${at} · subagent ${event.agentId} started (${untrustedText(event.agentType)}): ${untrustedText(event.description)}`;
    case "subagent_end":
      return `${at} · subagent ${event.agentId} ${event.stopReason}`;
    case "notice":
      return `${at} · ${untrustedText(event.text)}`;
  }
}

/**
 * `JSON.stringify` escapes C0 only: C1 (U+0080–U+009F) and DEL reach a terminal
 * raw, and a pod's text may carry them (AGENTS §7). One JSON line, escaped.
 */
export function jsonLine(value: unknown): string {
  return JSON.stringify(value).replace(
    // C1 (U+0080–U+009F) and DEL reach a terminal raw otherwise.
    /[\u007f-\u009f]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
}

/** What `--summary` reports (`--json`: one object; text: `formatSummary`). */
export interface LogSummary {
  readonly v: typeof LOG_EVENT_VERSION;
  readonly session: string;
  readonly file: string;
  readonly project: string;
  readonly model: string;
  readonly title?: string;
  /** The messages of the history it read. */
  readonly messages: number;
  readonly turns: number;
  readonly lastStopReason?: string;
  /** A turn started and not ended: the file's last state. */
  readonly openTurn?: string;
  readonly tools: readonly { readonly name: string; readonly count: number }[];
  readonly files: readonly string[];
  /** Kept segments dropped from the projection (a compaction's, a reset's). */
  readonly olderSegments: number;
  /** The detached run whose record names this session (`--summary` prints its logs, owner Q6). */
  readonly run?: { readonly name: string; readonly logs: readonly string[] };
}

/** The files the entries' `fs_*` calls named, in first-seen order. */
export function filesTouched(entries: readonly KnownLogEntry[]): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const item of projectMessages(entries)) {
    for (const call of item.message.toolCalls ?? []) {
      if (!FILE_TOOLS.includes(call.name)) {
        continue;
      }
      let path: unknown;
      try {
        path = (JSON.parse(call.arguments) as { path?: unknown }).path;
      } catch {
        continue;
      }
      if (typeof path === "string" && path !== "" && !seen.has(path)) {
        seen.add(path);
        paths.push(path);
      }
    }
  }
  return paths;
}

export interface SummaryFacts {
  readonly session: string;
  readonly file: string;
  readonly project: string;
  readonly model: string;
  readonly olderSegments: number;
  readonly run?: { readonly name: string; readonly logs: readonly string[] };
}

/** The summary of one log read (the entries' facts, never a guess from the rendered lines). */
export function summarize(
  entries: readonly KnownLogEntry[],
  events: readonly LogEvent[],
  facts: SummaryFacts,
): LogSummary {
  const counts = new Map<string, number>();
  const open = new Set<string>();
  let turns = 0;
  let lastStopReason: string | undefined;
  let title: string | undefined;
  for (const event of events) {
    switch (event.type) {
      case "tool_call":
        counts.set(event.name, (counts.get(event.name) ?? 0) + 1);
        break;
      case "turn_start":
        turns++;
        open.add(event.turnId);
        break;
      case "turn_end":
        open.delete(event.turnId);
        lastStopReason = event.stopReason;
        break;
      case "title":
        title = event.text;
        break;
      default:
        break;
    }
  }
  const tools = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const openTurn = [...open].at(-1);
  return {
    v: LOG_EVENT_VERSION,
    session: facts.session,
    file: facts.file,
    project: facts.project,
    model: facts.model,
    ...(title !== undefined ? { title } : {}),
    // The history it holds (a resume's projection), not a count of events.
    messages: projectMessages(entries).length,
    turns,
    ...(lastStopReason !== undefined ? { lastStopReason } : {}),
    ...(openTurn !== undefined ? { openTurn } : {}),
    tools,
    files: filesTouched(entries),
    olderSegments: facts.olderSegments,
    ...(facts.run !== undefined ? { run: facts.run } : {}),
  };
}

/** `--summary` as human lines (one fact per line). */
export function formatSummary(summary: LogSummary): string {
  const lines = [
    `session   ${summary.session}`,
    `file      ${summary.file}`,
    `project   ${untrustedText(summary.project)}`,
    `model     ${untrustedText(summary.model)}`,
    ...(summary.title !== undefined ? [`title     ${untrustedText(summary.title)}`] : []),
    `messages  ${summary.messages}`,
    `turns     ${summary.turns}${summary.lastStopReason !== undefined ? ` (last ${summary.lastStopReason})` : ""}`,
    ...(summary.openTurn !== undefined
      ? [`open turn ${summary.openTurn} (not ended in this file)`]
      : []),
    `tools     ${
      summary.tools.length === 0
        ? "(none)"
        : summary.tools.map((tool) => `${untrustedText(tool.name)} ×${tool.count}`).join(", ")
    }`,
    `files     ${
      summary.files.length === 0
        ? "(none)"
        : summary.files.map((file) => untrustedText(file)).join(", ")
    }`,
    ...(summary.olderSegments > 0
      ? [
          `segments  ${summary.olderSegments} older kept (a compaction/reset); the current one is above`,
        ]
      : []),
    // Owner Q6: a run's free-text logs are NOT merged in v1 — their paths are.
    ...(summary.run !== undefined
      ? [
          `run       ${untrustedText(summary.run.name)}`,
          ...(summary.run.logs.length === 0
            ? ["logs      (none kept yet)"]
            : summary.run.logs.map((log) => `logs      ${untrustedText(log)}`)),
        ]
      : []),
  ];
  return `${lines.join("\n")}\n`;
}
