/**
 * The queue-diagnosis trace (docs/fix/mobile-queued-stuck.md): one formatting
 * module for the `qtrace` lines a device capture needs, so the phone's exported
 * log says WHERE a queue row's clearing `queued` update goes.
 *
 * The bug this exists for: a row left in the composer for ever, while a leave +
 * re-enter looks right. A row leaves the phone's list only on a `queued`
 * broadcast that no longer lists it (`compose-queue.ts` `shownRows`), and the
 * TUI *also* clears at turn end (`packages/tui/src/queued.ts` `onTurnEnd`) while
 * mobile has no such hook — so the frame, if it goes missing, is unrecoverable
 * here. Which layer loses it (daemon emit, the link, the client's reducer, this
 * screen's apply, or a later re-report reviving the row) cannot be told from the
 * screenshot, and every layer the laptop can drive is green. Hence a capture.
 *
 * What a line may contain: ids (8 characters, `app-log.ts` `shortId`), counts,
 * and short enums. There is NO text field at all — not the row's text, not the
 * daemon's — because the export is a file a person shares (app-log D7/F16). The
 * formatter is pure and React-free (AGENTS §7): the call sites only hand it an
 * event and pass its answer to the ONE app log.
 *
 * Every entry's `kind` is `qtrace` and its `ev` field names the event, so one
 * grep finds the whole story: `grep qtrace tentacle-logs-*.txt`.
 */
import type { AppLog, AppLogField } from "./app-log.ts";
import { shortId } from "./app-log.ts";

/** The app-log kind every trace line carries (the owner's grep). */
export const QTRACE = "qtrace";

/** Where a `queued` report came from: the second half of the diagnosis. */
export type TraceSource = "live" | "replay" | "current" | "snapshot";

/** How many row ids one line names; the rest are counted by `more`. */
export const TRACE_IDS_MAX = 6;

/**
 * One thing worth seeing in a capture. `queued-received` names the ids the
 * daemon's report LISTED, and `rows` names the ids the UI SHOWS after it — the
 * pair is the whole diagnosis: the same ids in both means the report was not the
 * one that clears the row; absent in `rows` only means it was applied and the
 * screen is stale.
 */
export type QueueTraceEvent =
  /**
   * One full `queued` report REACHED this phone. `source` says where it came
   * from, which is the second half of the diagnosis: `live` (a frame, applied
   * as it arrived), `replay` (the client's held state, delivered at subscribe),
   * `current` (the one report read through `queued()`), `snapshot` (a resync's).
   */
  | {
      readonly kind: "queued-received";
      readonly source: TraceSource;
      readonly entries: readonly string[];
      readonly returned: number;
    }
  /**
   * A batch that reported dropped updates (`lost: N`). The phone's stack has no
   * `lost` surface today (only `tentacle logs`' watch does: `client/watch.ts`),
   * so this is wired where a loss WOULD be counted; a gap on this link surfaces
   * as a `snapshot` instead. Kept because the owner asked for it and because the
   * event may become reachable without a format change.
   */
  | { readonly kind: "batch-lost"; readonly lost: number }
  /** A turn opened (`own`: this phone's send, not another device's). */
  | { readonly kind: "turn-start"; readonly turnId: string; readonly own: boolean }
  /** A turn closed, with the outcome the fold decided. */
  | { readonly kind: "turn-end"; readonly turnId: string | null; readonly outcome: string }
  /** The link's own up/down (`RemoteClient.onLinkStatus`). */
  | { readonly kind: "link"; readonly state: "up" | "down" }
  /** An attach: started, answered, or failed (a Retry/Reopen is `reopen: true`). */
  | {
      readonly kind: "attach";
      readonly state: "start" | "ok" | "fail";
      readonly reopen: boolean;
      /** The typed failure reason (`session-controller.ts`), on `fail` only. */
      readonly reason?: string;
    }
  /** A history event: a snapshot (`reason: null`) or a replace (`clear`, …). */
  | {
      readonly kind: "history";
      readonly reason: "compact" | "context_reset" | "clear" | null;
      readonly messages: number;
    }
  /** The pull-to-refresh / foreground re-attach (the person's own recovery). */
  | { readonly kind: "resync"; readonly state: "start" | "done" | "failed" | "kept" }
  /** A local compose act, and the local row id it minted or moved. */
  | {
      readonly kind: "compose";
      readonly act: "enqueue" | "send-now" | "reject" | "unqueue";
      readonly row: string;
    }
  /** Stop: a turn cancelled from this phone (`own`: its own stream, not another's). */
  | { readonly kind: "cancel"; readonly turnId: string | null; readonly own: boolean }
  /**
   * The queue rows the UI SHOWS, read from the pure view function after the act
   * named by `where` — the other half of every line above it.
   */
  | { readonly kind: "rows"; readonly where: string; readonly ids: readonly string[] };

/** One app-log entry's own content, as `AppLog.log` takes it. */
export interface TraceLine {
  readonly level: "info" | "warn";
  readonly kind: typeof QTRACE;
  readonly fields: Readonly<Record<string, AppLogField>>;
}

/** The first `TRACE_IDS_MAX` ids of a list, 8 characters each, plus the overflow count. */
function idFields(ids: readonly string[]): Record<string, AppLogField> {
  const fields: Record<string, AppLogField> = { n: ids.length };
  ids.slice(0, TRACE_IDS_MAX).forEach((id, i) => {
    fields[`id${i}`] = shortId(id);
  });
  if (ids.length > TRACE_IDS_MAX) {
    fields.more = ids.length - TRACE_IDS_MAX;
  }
  return fields;
}

/** A row id as a line may name it: 8 characters, never empty. */
function row(id: string): string {
  return id === "" ? "-" : shortId(id);
}

/**
 * One `qtrace` line: the session (8 characters), the event, and that event's own
 * safe fields. Pure — the caller only passes the answer to the app log, so no
 * call site can decide what a shared file contains.
 */
export function traceLine(sessionId: string, event: QueueTraceEvent): TraceLine {
  const base: Record<string, AppLogField> = { s: shortId(sessionId), ev: event.kind };
  const line = (fields: Record<string, AppLogField>): TraceLine => ({
    level: "info",
    kind: QTRACE,
    fields: { ...base, ...fields },
  });
  switch (event.kind) {
    case "queued-received":
      return line({
        src: event.source,
        ...idFields(event.entries.map((id) => id)),
        returned: event.returned,
      });
    case "batch-lost":
      return { level: "warn", kind: QTRACE, fields: { ...base, lost: event.lost } };
    case "turn-start":
      return line({ turn: row(event.turnId), own: event.own });
    case "turn-end":
      return line({
        turn: event.turnId === null ? "-" : row(event.turnId),
        outcome: event.outcome,
      });
    case "link":
      return line({ state: event.state });
    case "attach":
      return event.reason === undefined
        ? line({ state: event.state, reopen: event.reopen })
        : {
            level: event.state === "fail" ? "warn" : "info",
            kind: QTRACE,
            fields: { ...base, state: event.state, reopen: event.reopen, why: event.reason },
          };
    case "history":
      return line({ reason: event.reason ?? "none", msgs: event.messages });
    case "resync":
      return event.state === "failed"
        ? { level: "warn", kind: QTRACE, fields: { ...base, state: event.state } }
        : line({ state: event.state });
    case "compose":
      return line({ act: event.act, row: row(event.row) });
    case "cancel":
      return line({ turn: event.turnId === null ? "-" : row(event.turnId), own: event.own });
    case "rows":
      return line({ where: event.where, ...idFields(event.ids) });
  }
}

/** Somewhere to report an event: the one thing every call site is given. */
export type QueueTrace = (event: QueueTraceEvent) => void;

/**
 * A trace over the app's ONE log: format here, `log.log` here — so no call site
 * decides what a shared file contains, and every line is `kind=qtrace` (the
 * owner's grep). Absent (`undefined` at the seam) the trace is a no-op, which is
 * how the tests that predate this diagnostic keep their exact shape.
 */
export function queueTrace(sessionId: string, log: AppLog): QueueTrace {
  return (event) => {
    const line = traceLine(sessionId, event);
    log.log(line.level, line.kind, line.fields);
  };
}
