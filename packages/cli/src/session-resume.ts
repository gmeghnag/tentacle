/**
 * `--resume [uid]`: pick the session to resume and say what happened — one
 * copy for the TUI and the pod (`run`/`attach`) paths. An unreadable file is
 * never mistaken for "no session": with an explicit uid it is fatal (the user
 * asked for THAT session); without one the newest valid session resumes and the
 * skipped files are reported both before mount and inside the TUI (the
 * pre-mount line alone is hidden by the alternate screen until exit).
 *
 * With a `pick` (`--resume` on a terminal, docs/feat/resume-picker.md) and two
 * or more sessions, the user chooses; without one (`--continue`, or no
 * terminal) the newest resumes.
 */
import {
  type LoadResult,
  type SessionRecord,
  isValidSessionId,
  projectKey,
  recordTitleText,
} from "@tentacle/agent";
import type { LogSessionStore, SessionSummary } from "@tentacle/daemon";
import type { SessionChoice, SessionPick } from "@tentacle/tui";

/**
 * What resuming reads: `list` gives every session's summary (a quick walk of
 * each log, docs/feat/session-log-laptop-store.md Q5), `load` the chosen one's
 * full, strictly checked history.
 */
export type ResumeStore = Pick<LogSessionStore, "load" | "list">;

/**
 * The project the store belongs to (docs/fix/session-store-per-project.md):
 * a uid found in ANOTHER project is refused, never resumed here.
 */
export interface ResumeScope {
  /** This project's cwd, named in messages. */
  readonly cwd: string;
  /** Its `projectKey`. */
  readonly key: string;
  /** Where else the uid may be (the other projects). */
  readonly elsewhere: (uid: string) => Promise<LoadResult>;
}

export interface ResumeResolution {
  readonly record: SessionRecord | null;
  /** Lines to write before the TUI mounts. */
  readonly lines: readonly string[];
  /** Notices to show inside the TUI. */
  readonly notices: readonly string[];
  /** Don't start: the requested session exists but can't be read. */
  readonly fatal: boolean;
  /** Don't start: the user cancelled the picker (not an error). */
  readonly cancelled?: true;
}

export async function resolveResume(
  store: ResumeStore,
  uid: string | undefined,
  scope?: ResumeScope,
  pick?: SessionPick,
): Promise<ResumeResolution> {
  if (uid !== undefined) {
    if (!isValidSessionId(uid)) {
      return {
        record: null,
        lines: [`[resume] "${uid}" is not a valid session id; not starting\n`],
        notices: [],
        fatal: true,
      };
    }
    let result = await store.load(uid);
    if (result.status === "absent" && scope) {
      result = await scope.elsewhere(uid);
      if (result.status === "ok" && projectKey(result.record.cwd) !== scope.key) {
        // Resuming another project's conversation here is the defect itself.
        return fatal(
          `[resume] session "${uid}" belongs to ${result.record.cwd}; run tentacle there to resume it\n`,
        );
      }
    }
    switch (result.status) {
      case "ok":
        return found(result.record, []);
      case "absent":
        return {
          record: null,
          lines: [`[resume] no session "${uid}"; starting fresh\n`],
          notices: [],
          fatal: false,
        };
      case "unreadable":
        return fatal(
          `[resume] session "${uid}" is unreadable: ${result.reason} (${result.file}); not starting — fix or remove the file, or run without --resume\n`,
        );
    }
  }
  const { records, skipped } = await store.list();
  const warning =
    skipped.length > 0
      ? [
          `⚠ Skipped ${skipped.length} unreadable session file(s): ${skipped
            .map((s) => `${s.file} (${s.reason})`)
            .join(", ")}`,
        ]
      : [];
  if (pick && records.length >= 2) {
    const id = await pick(records.map(toChoice));
    if (id === null) {
      return {
        record: null,
        lines: [],
        notices: [],
        fatal: false,
        cancelled: true,
      };
    }
    const chosen = records.find((r) => r.id === id);
    if (!chosen) {
      return fatal(`[resume] the picker returned an unknown session "${id}"; not starting\n`);
    }
    return loadChosen(store, chosen, warning);
  }
  const newest = records[0];
  if (!newest) {
    return {
      record: null,
      lines: [
        ...warning.map((w) => `[resume] ${w}\n`),
        scope
          ? `[resume] no saved sessions for ${scope.cwd} yet; starting fresh\n`
          : "[resume] no saved sessions yet; starting fresh\n",
      ],
      notices: warning,
      fatal: false,
    };
  }
  return loadChosen(store, newest, warning);
}

/** The chosen summary's full history (strictly checked: a summary is a quick walk). */
async function loadChosen(
  store: ResumeStore,
  chosen: SessionSummary,
  warning: readonly string[],
): Promise<ResumeResolution> {
  const result = await store.load(chosen.id);
  switch (result.status) {
    case "ok":
      return found(result.record, warning);
    case "absent":
      return fatal(`[resume] session "${chosen.id}" vanished while resuming; not starting\n`);
    case "unreadable":
      return fatal(
        `[resume] session "${chosen.id}" is unreadable: ${result.reason} (${result.file}); not starting — fix or remove the file, or run without --resume\n`,
      );
  }
}

function toChoice(summary: SessionSummary): SessionChoice {
  return {
    id: summary.id,
    title: recordTitleText(summary),
    updatedAt: summary.updatedAt,
    messageCount: summary.messageCount,
  };
}

function fatal(line: string): ResumeResolution {
  return { record: null, lines: [line], notices: [], fatal: true };
}

function found(record: SessionRecord, warning: readonly string[]): ResumeResolution {
  return {
    record,
    lines: [
      ...warning.map((w) => `[resume] ${w}\n`),
      `[resume] ${record.id} — ${recordTitleText(record)}\n`,
    ],
    notices: warning,
    fatal: false,
  };
}
