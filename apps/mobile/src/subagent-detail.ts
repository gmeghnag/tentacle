/**
 * The detail of one thing in the Activity sheet (docs/feat/mobile-chrome.md
 * Design 5, slice S9): a RUNNING child (its latest steps, the person's messages
 * with "read" marks, Message and Stop), a FINISHED one (its report, Copy, Show in
 * chat) and a background shell job (its output tail and Stop). Also the typed
 * outcomes of those actions, so a refusal or a dropped link is a notice and never
 * a throw at the UI (F14, F15, F19).
 *
 * Every label may come from a pod (§7): flattened to one plain line (F16).
 *
 * Pure, React-free (AGENTS §7).
 */
import type { JobOutputResult, JobRow, SubagentRow } from "@tentacle/protocol";
import type { ChildReport, FinishedChild } from "./activity-memory.ts";
import { elapsed, oneLine } from "./activity.ts";

/** How many of a child's latest steps the detail shows (owner Q17). */
export const STEPS_SHOWN = 5;
/** How many of the person's messages to one child the detail shows. */
export const SENT_SHOWN = 5;
/** How many output lines of a shell job are read and shown. */
export const JOB_LINES = 200;

/** One text the person sent to a child, as the daemon echoed it (`n`: its index; absent from an older daemon). */
export interface SentMessage {
  readonly text: string;
  readonly n?: number;
}

/** How many of the person's messages are kept per child (this attach only). */
export const SENT_CAP = 20;

export type SentMemory = Readonly<Record<string, readonly SentMessage[]>>;

/**
 * One echo of the person's message to a child (`subagent_message`): kept per
 * child, newest last, at most `SENT_CAP`. The echo is the only source — never a
 * local copy — so a message sent from the TUI shows too, and none twice.
 */
export function recordSent(memory: SentMemory, agentId: string, message: SentMessage): SentMemory {
  const list = [...(memory[agentId] ?? []), message].slice(-SENT_CAP);
  return { ...memory, [agentId]: list };
}

/** Forget the messages of children that are neither live nor Finished (bounded with them). */
export function pruneSent(memory: SentMemory, keep: ReadonlySet<string>): SentMemory {
  const ids = Object.keys(memory);
  if (ids.every((id) => keep.has(id))) {
    return memory;
  }
  return Object.fromEntries(ids.filter((id) => keep.has(id)).map((id) => [id, memory[id] ?? []]));
}

/**
 * Whether a message was READ — entered the child's context. The phone's copy of
 * the TUI's `sentState` (`packages/tui/src/background-list.ts`; the app does not
 * depend on the TUI): `n <= userRead` is read; a child that ended first never
 * read it; with `n` or `userRead` absent (an older daemon) there is no claim.
 */
export function sentState(
  n: number | undefined,
  userRead: number | undefined,
  ended: boolean,
): "read" | "unread" | "unread_ended" | "unknown" {
  if (n !== undefined && userRead !== undefined && n <= userRead) {
    return "read";
  }
  if (ended) {
    return "unread_ended";
  }
  if (n === undefined || userRead === undefined) {
    return "unknown";
  }
  return "unread";
}

const SENT_MARK = {
  read: "read",
  unread: "not read yet",
  unread_ended: "not read",
  unknown: "sent",
} as const;

export type DetailTarget =
  | { readonly kind: "live"; readonly row: SubagentRow }
  | {
      readonly kind: "finished";
      readonly child: FinishedChild;
      readonly report: ChildReport | null;
    };

export interface DetailStep {
  readonly key: string;
  readonly text: string;
  /** The newest step of a running child (drawn with a spinner). */
  readonly latest: boolean;
}

export interface DetailSent {
  readonly key: string;
  readonly text: string;
  readonly mark: (typeof SENT_MARK)[keyof typeof SENT_MARK];
}

export interface SubagentDetailView {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly running: boolean;
  /** `… n earlier`, or `null` when every step is shown. */
  readonly earlier: string | null;
  /** Oldest first; empty for a finished child (its report says what it did). */
  readonly steps: readonly DetailStep[];
  readonly sent: readonly DetailSent[];
  readonly actions: {
    readonly message: boolean;
    readonly stop: boolean;
    readonly copy: boolean;
    readonly show: boolean;
  };
  readonly placeholder: string;
}

function tokens(n: number): string {
  if (n < 1000) {
    return `${n} tokens`;
  }
  if (n < 1_000_000) {
    return `${(n / 1000).toFixed(1)}k tokens`;
  }
  return `${(n / 1_000_000).toFixed(1)}M tokens`;
}

function steps(n: number): string {
  return n === 1 ? "1 step" : `${n} steps`;
}

export function detailView(
  target: DetailTarget,
  sent: readonly SentMessage[],
  now: number,
): SubagentDetailView {
  const live = target.kind === "live";
  const row = live ? target.row : target.child.row;
  const window = live ? row.tail.slice(-STEPS_SHOWN) : [];
  const earlier = live ? Math.max(0, row.toolUses - window.length) : 0;
  const report = live ? null : target.report;
  const outcome = live
    ? null
    : report === null
      ? "report pending"
      : report.lost
        ? "lost"
        : "finished";
  return {
    id: row.id,
    title: oneLine(row.description),
    meta: [
      outcome ?? oneLine(row.state),
      row.id,
      oneLine(row.agentType),
      ...(row.model === undefined ? [] : [oneLine(row.model)]),
      steps(row.toolUses),
      ...(live ? [elapsed(now - row.startedAt)] : []),
      tokens(row.tokens),
    ].join(" · "),
    running: live,
    earlier: earlier > 0 ? `… ${earlier} earlier` : null,
    steps: window.map((text, i) => ({
      key: `step-${row.toolUses - window.length + i}`,
      text: oneLine(text),
      latest: i === window.length - 1,
    })),
    sent: sent.slice(-SENT_SHOWN).map((m, i) => ({
      key: `sent-${m.n ?? `i${i}`}`,
      text: oneLine(m.text),
      mark: SENT_MARK[sentState(m.n, row.userRead, !live)],
    })),
    actions: {
      message: live,
      stop: live,
      copy: report !== null,
      show: report !== null,
    },
    placeholder: `Message ${row.id}…`,
  };
}

/** What the screen shows for a focus: the child's live row, its Finished entry, or a job. */
export type ActivityFocus =
  | { readonly kind: "child"; readonly id: string }
  | { readonly kind: "job"; readonly id: string }
  | null;

/**
 * A focused child as it stands NOW: live while it is in the list (the live row
 * wins over a stale Finished one), else Finished (so a child that ends while its
 * detail is open flips to its report — F14), else `null` (the list).
 */
export function resolveFocus(
  focus: ActivityFocus,
  live: readonly SubagentRow[] | null,
  finished: readonly FinishedChild[],
  reports: ReadonlyMap<string, ChildReport>,
): DetailTarget | null {
  if (focus === null || focus.kind !== "child") {
    return null;
  }
  const row = (live ?? []).find((r) => r.id === focus.id);
  if (row !== undefined) {
    return { kind: "live", row };
  }
  const child = finished.find((f) => f.row.id === focus.id);
  if (child !== undefined) {
    return { kind: "finished", child, report: reports.get(focus.id) ?? null };
  }
  return null;
}

export interface SheetDetailInput {
  readonly subagents: readonly SubagentRow[] | null;
  readonly jobs: readonly JobRow[] | null;
  readonly finished: readonly FinishedChild[];
  readonly reports: ReadonlyMap<string, ChildReport>;
  readonly sent: SentMemory;
  /** The open job's last read, as the controller holds it. */
  readonly job: { readonly id: string; readonly output: JobOutputResult | null } | null;
}

export type SheetDetail =
  | {
      readonly kind: "child";
      readonly view: SubagentDetailView;
      readonly report: ChildReport | null;
    }
  | { readonly kind: "job"; readonly view: JobDetailView }
  | null;

/**
 * What the sheet draws for a focus: a child's detail (live or Finished, as it
 * stands NOW), a job's (also once it left the list: its last output and how it
 * ended — F19), or `null` (the list).
 */
export function sheetDetail(
  focus: ActivityFocus,
  input: SheetDetailInput,
  now: number,
): SheetDetail {
  if (focus === null) {
    return null;
  }
  if (focus.kind === "job") {
    const live = (input.jobs ?? []).find((j) => j.id === focus.id) ?? null;
    const output = input.job?.id === focus.id ? input.job.output : null;
    return { kind: "job", view: jobDetailView(focus.id, live, output, now) };
  }
  const target = resolveFocus(focus, input.subagents, input.finished, input.reports);
  if (target === null) {
    return null;
  }
  return {
    kind: "child",
    view: detailView(target, input.sent[focus.id] ?? [], now),
    report: target.kind === "finished" ? target.report : null,
  };
}

/** "Show in chat": the transcript index of the report's own row; `null` when it is not there. */
export function showRow(
  rows: readonly { readonly key: string }[],
  report: ChildReport | null,
): number | null {
  if (report === null) {
    return null;
  }
  const at = rows.findIndex((r) => r.key === report.key);
  return at < 0 ? null : at;
}

/** A send's outcome: a refusal or a throw keeps the draft and says why (F14, F15). */
export function messageOutcome(
  result: { readonly ok: boolean; readonly reason?: string } | Error,
): {
  readonly keepDraft: boolean;
  readonly notice: string | null;
} {
  if (result instanceof Error) {
    return { keepDraft: true, notice: `Not sent: ${result.message}` };
  }
  if (result.ok) {
    return { keepDraft: false, notice: null };
  }
  return { keepDraft: true, notice: oneLine(result.reason ?? "") || "Not sent." };
}

function killOutcome(
  id: string,
  result: { readonly killed: boolean } | Error,
  already: string,
): string | null {
  if (result instanceof Error) {
    return `Not stopped: ${result.message}`;
  }
  return result.killed ? null : `${id} ${already}`;
}

/** Stop's outcome: `{killed:false}` is a race the child won (F14). */
export function killChildOutcome(
  id: string,
  result: { readonly killed: boolean } | Error,
): string | null {
  return killOutcome(id, result, "already finished");
}

/** A shell job's Stop: `{killed:false}` is a job that already exited (F19). */
export function killJobOutcome(
  id: string,
  result: { readonly killed: boolean } | Error,
): string | null {
  return killOutcome(id, result, "already exited");
}

/** Stop is destructive: one confirmation that names what is lost (F17). */
export function stopConfirm(target: { readonly kind: "child" | "job"; readonly id: string }): {
  readonly title: string;
  readonly message: string;
  readonly confirm: string;
} {
  return {
    title: `Stop ${target.id}?`,
    message:
      target.kind === "child"
        ? "Its work so far is lost to the agent."
        : "The process is killed; its output so far stays readable.",
    // Not the bare "Stop" of the link that opened it: one label per button.
    confirm: target.kind === "child" ? "Stop agent" : "Stop job",
  };
}

export interface JobDetailView {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  /** Oldest first, at most `JOB_LINES`, each one plain line. */
  readonly lines: readonly string[];
  /** Older output was dropped (by the daemon's buffer or this window). */
  readonly truncated: boolean;
  /** `exited (code n)` / `killed` / the daemon's status, once it is not running; else `null`. */
  readonly ended: string | null;
  readonly stop: boolean;
  /** Why nothing could be read (`found: false`). */
  readonly notice: string | null;
}

/**
 * A shell job's detail: the live row (`null` once it left the list) and the last
 * output read. A job that just exited keeps the output it has plus how it ended
 * (F19); Stop only while it runs.
 */
export function jobDetailView(
  id: string,
  live: JobRow | null,
  output: JobOutputResult | null,
  now: number,
): JobDetailView {
  const status = output?.status ?? live?.status ?? null;
  const running = live !== null && (status === null || status === "running");
  const all = output?.output ?? [];
  const lines = all.slice(-JOB_LINES).map(oneLine);
  const command = output?.command ?? live?.command;
  const startedAt = output?.startedAt ?? live?.startedAt;
  const ended =
    running || status === null
      ? null
      : output?.exitCode !== undefined
        ? `exited (code ${output.exitCode})`
        : oneLine(status);
  return {
    id,
    title: command === undefined ? id : oneLine(command),
    meta: [
      id,
      ...(status === null ? [] : [oneLine(status)]),
      ...(startedAt === undefined || !running ? [] : [elapsed(now - startedAt)]),
    ].join(" · "),
    lines,
    truncated: output?.truncated === true || all.length > lines.length,
    ended,
    stop: running,
    notice: output !== null && !output.found ? oneLine(output.reason ?? "") || "Not found." : null,
  };
}
