/**
 * `--resume [uid]`: pick the session to resume and say what happened — one
 * copy for the TUI and the pod (`run`/`attach`) paths. An unreadable file is
 * never mistaken for "no session": with an explicit uid it is fatal (the user
 * asked for THAT session); without one the newest valid session resumes and the
 * skipped files are reported both before mount and inside the TUI (the
 * pre-mount line alone is hidden by the alternate screen until exit).
 */
import { type JsonSessionStore, type SessionRecord, isValidSessionId } from "@tentacle/agent";

export interface ResumeResolution {
  readonly record: SessionRecord | null;
  /** Lines to write before the TUI mounts. */
  readonly lines: readonly string[];
  /** Notices to show inside the TUI. */
  readonly notices: readonly string[];
  /** Don't start: the requested session exists but can't be read. */
  readonly fatal: boolean;
}

export async function resolveResume(
  store: JsonSessionStore,
  uid: string | undefined,
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
    const result = await store.load(uid);
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
        return {
          record: null,
          lines: [
            `[resume] session "${uid}" is unreadable: ${result.reason} (${result.file}); not starting — fix or remove the file, or run without --resume\n`,
          ],
          notices: [],
          fatal: true,
        };
    }
  }
  const { record, skipped } = await store.latest();
  const warning =
    skipped.length > 0
      ? [
          `⚠ Skipped ${skipped.length} unreadable session file(s): ${skipped
            .map((s) => `${s.file} (${s.reason})`)
            .join(", ")}`,
        ]
      : [];
  if (!record) {
    return {
      record: null,
      lines: [
        ...warning.map((w) => `[resume] ${w}\n`),
        "[resume] no saved sessions yet; starting fresh\n",
      ],
      notices: warning,
      fatal: false,
    };
  }
  return found(record, warning);
}

function found(record: SessionRecord, warning: readonly string[]): ResumeResolution {
  return {
    record,
    lines: [...warning.map((w) => `[resume] ${w}\n`), `[resume] ${record.id} — ${record.title}\n`],
    notices: warning,
    fatal: false,
  };
}
