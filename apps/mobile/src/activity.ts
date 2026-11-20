/**
 * The Activity sheet's view-model (docs/feat/mobile-chrome.md Design 5, slice S8):
 * what runs beside the conversation, grouped by kind, running first — background
 * sub-agents (`subagents` update), background shell jobs (`jobs` update), the
 * phone's own Finished memory (`activity-memory.ts`) and the session's armed
 * scheduled wakes (`schedules` update; one summary row that opens Session info's
 * SCHEDULED WAKES, docs/fix/mobile-qa-sweep.md). Also the header pill's rule and
 * the transcript card's target.
 *
 * Every string here may come from a pod (§7, "a pod is not trusted"): it is
 * flattened to one line of plain text and never interpreted (F16).
 *
 * Pure, React-free (AGENTS §7).
 */
import type { JobRow, ScheduleRow, SubagentRow } from "@tentacle/protocol";
import type { ChildReport, FinishedChild } from "./activity-memory.ts";
import { scheduleMetaText, scheduleTitle, wakesBadge } from "./schedule-view.ts";

export interface ActivityInput {
  /** The live list; `null` until the daemon reports one (an older daemon never does). */
  readonly subagents: readonly SubagentRow[] | null;
  /** The live jobs and the daemon's own running count (H1); `null` until reported. */
  readonly jobs: { readonly rows: readonly JobRow[]; readonly count: number } | null;
  readonly finished: readonly FinishedChild[];
  readonly reports: ReadonlyMap<string, ChildReport>;
  readonly opened: readonly string[];
  /** The armed wakes; `undefined` until the daemon reports them (one without the feed never does). */
  readonly schedules: readonly ScheduleRow[] | undefined;
}

export interface ActivityRowView {
  readonly key: string;
  /** `scheduled`: the wakes' one summary row, a tap opens Session info's SCHEDULED WAKES. */
  readonly kind: "subagent" | "job" | "finished" | "scheduled";
  /** `sa-N` / `bg-N`. */
  readonly id: string;
  readonly title: string;
  /** The title is a command (drawn mono). */
  readonly mono: boolean;
  readonly meta: string;
  /** The latest step (a running sub-agent only). */
  readonly step?: string;
  readonly running: boolean;
  /** A Finished row whose report is in the conversation. */
  readonly hasReport: boolean;
  /** …and the person has not opened it yet. */
  readonly unread: boolean;
}

export type ActivityGroupKind = "subagents" | "jobs" | "finished" | "scheduled";

export interface ActivityGroup {
  readonly kind: ActivityGroupKind;
  readonly title: string;
  readonly rows: readonly ActivityRowView[];
  /** The dimmed line drawn when `rows` is empty (Scheduled only); `null` for a live group. */
  readonly empty: string | null;
}

export interface ActivityView {
  /** Running sub-agents + running shell jobs. */
  readonly count: number;
  /** Finished reports not opened yet. */
  readonly unread: number;
  /** The header pill is drawn. */
  readonly badge: boolean;
  readonly badgeLabel: string;
  readonly accessibilityLabel: string;
  readonly groups: readonly ActivityGroup[];
  /** The dimmed line drawn when `groups` is empty (no wake feed, nothing running); else `null`. */
  readonly empty: string | null;
  /**
   * No group has a row: only Scheduled's own empty state, or nothing at all. The
   * hub's Activity is DIMMED then (mobile-hub-tap Design 2: an empty Activity says
   * "Nothing running" inline, the modal never opens). `groups.length === 0` was
   * never true again once the wake feed added an empty Scheduled group
   * (fix/mobile-e2e-reds, flow 33).
   */
  readonly nothingRunning: boolean;
}

/** One line of plain text: control characters and line breaks become spaces. */
export function oneLine(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: flattening untrusted text
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
}

/** A duration as the sheet shows it: `9s`, `2m 05s`, `1h 02m`. Never negative (clock skew). */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) {
    return `${s}s`;
  }
  const m = Math.floor(s / 60);
  if (m < 60) {
    return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  }
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function steps(n: number): string {
  return n === 1 ? "1 step" : `${n} steps`;
}

function subagentRow(row: SubagentRow, now: number): ActivityRowView {
  const latest = row.tail.at(-1);
  return {
    key: `sa:${row.id}`,
    kind: "subagent",
    id: row.id,
    title: oneLine(row.description),
    mono: false,
    meta: [
      row.id,
      oneLine(row.agentType),
      ...(row.model === undefined ? [] : [oneLine(row.model)]),
      ...(row.state === "running" ? [] : [oneLine(row.state)]),
      steps(row.toolUses),
      elapsed(now - row.startedAt),
    ].join(" · "),
    ...(latest === undefined ? {} : { step: oneLine(latest) }),
    running: true,
    hasReport: false,
    unread: false,
  };
}

function jobRow(row: JobRow, now: number): ActivityRowView {
  return {
    key: `bg:${row.id}`,
    kind: "job",
    id: row.id,
    title: oneLine(row.command),
    mono: true,
    meta: [row.id, oneLine(row.status), elapsed(now - row.startedAt)].join(" · "),
    running: true,
    hasReport: false,
    unread: false,
  };
}

function finishedRow(
  f: FinishedChild,
  reports: ReadonlyMap<string, ChildReport>,
  opened: readonly string[],
): ActivityRowView {
  const report = reports.get(f.row.id);
  const outcome = report === undefined ? "report pending" : report.lost ? "lost" : "finished";
  return {
    key: `done:${f.row.id}`,
    kind: "finished",
    id: f.row.id,
    title: oneLine(f.row.description),
    mono: false,
    meta: [f.row.id, oneLine(f.row.agentType), steps(f.row.toolUses), outcome].join(" · "),
    running: false,
    hasReport: report !== undefined,
    unread: report !== undefined && !opened.includes(f.row.id),
  };
}

/**
 * The Scheduled group: the count and the SOONEST wake (the daemon's order is not
 * the firing order), as ONE row — the wakes live, and are deleted, in Session
 * info's SCHEDULED WAKES, which the row opens. No wakes → an empty state; a
 * daemon that never reported the feed → no group (never a fake "soon").
 */
function scheduledGroup(
  rows: readonly ScheduleRow[] | undefined,
  now: number,
): ActivityGroup | null {
  if (rows === undefined) {
    return null;
  }
  const soonest = rows.reduce<ScheduleRow | undefined>(
    (best, row) => (best === undefined || row.nextAt < best.nextAt ? row : best),
    undefined,
  );
  if (soonest === undefined) {
    return { kind: "scheduled", title: "Scheduled", rows: [], empty: "No scheduled wakes" };
  }
  return {
    kind: "scheduled",
    title: `Scheduled · ${wakesBadge(rows.length)}`,
    rows: [
      {
        key: "scheduled",
        kind: "scheduled",
        id: "scheduled",
        title: scheduleTitle(soonest),
        mono: false,
        meta: `next · ${scheduleMetaText(soonest, now)}`,
        running: false,
        hasReport: false,
        unread: false,
      },
    ],
    empty: null,
  };
}

export function activityView(input: ActivityInput, now: number): ActivityView {
  const agents = (input.subagents ?? []).map((row) => subagentRow(row, now));
  const jobs = (input.jobs?.rows ?? []).map((row) => jobRow(row, now));
  const jobCount = Math.max(input.jobs?.count ?? 0, jobs.length);
  const finished = input.finished.map((f) => finishedRow(f, input.reports, input.opened));
  const count = agents.length + jobCount;
  const unread = finished.filter((r) => r.unread).length;
  const groups: ActivityGroup[] = [];
  if (agents.length > 0) {
    groups.push({
      kind: "subagents",
      title: `Sub-agents · ${agents.length} running`,
      rows: agents,
      empty: null,
    });
  }
  if (jobCount > 0) {
    groups.push({
      kind: "jobs",
      title: `Shell jobs · ${jobCount} running`,
      rows: jobs,
      empty: null,
    });
  }
  if (finished.length > 0) {
    groups.push({ kind: "finished", title: "Finished", rows: finished, empty: null });
  }
  const scheduled = scheduledGroup(input.schedules, now);
  if (scheduled !== null) {
    groups.push(scheduled);
  }
  const badgeLabel = count > 0 ? String(count) : unread > 0 ? `${unread} new` : "";
  const accessibilityLabel =
    count > 0
      ? `Activity, ${count} running`
      : unread > 0
        ? `Activity, ${unread} new ${unread === 1 ? "report" : "reports"}`
        : "Activity";
  return {
    count,
    unread,
    badge: count > 0 || unread > 0,
    badgeLabel,
    accessibilityLabel,
    groups,
    empty: groups.length === 0 ? "Nothing running" : null,
    nothingRunning: groups.every((group) => group.rows.length === 0),
  };
}

/**
 * The Finished row whose report the sheet shows for `focus`; `null` → the list.
 * A focus on a RUNNING child (its card tapped while it runs) is the list too:
 * its live detail is S9's.
 */
export function reportRow(view: ActivityView, focus: string | null): ActivityRowView | null {
  if (focus === null) {
    return null;
  }
  for (const group of view.groups) {
    const hit = group.rows.find((row) => row.kind === "finished" && row.id === focus);
    if (hit !== undefined) {
      return hit;
    }
  }
  return null;
}

/**
 * The child an `agent_task` card in the transcript opens: a background launch is
 * the live (or Finished) row with that `callId`; a foreground child that moved to
 * the background is its `movedTo` id. `null`: a plain tool row (F15).
 */
export function agentCardTarget(
  callId: string,
  movedTo: string | undefined,
  live: readonly SubagentRow[] | null,
  finished: readonly FinishedChild[],
): string | null {
  if (movedTo !== undefined) {
    return movedTo;
  }
  const hit =
    (live ?? []).find((row) => row.callId === callId) ??
    finished.find((f) => f.row.callId === callId)?.row;
  return hit?.id ?? null;
}
