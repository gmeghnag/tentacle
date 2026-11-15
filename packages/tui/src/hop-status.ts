/**
 * The row a hop paints while it runs (docs/feat/session-hop.md D3), pure: no
 * React, no phase knowledge. The phases themselves are the orchestrator's own
 * words (`cli/src/session-hop.ts`'s status sink, e.g. `moving to docker:box —
 * opening the session`), which already name the target; a hop that has not
 * reported a phase yet gets the one line `hopStatusLabel` builds. The row is cut
 * to the terminal width here — an image ref can be long and a hop must never
 * widen the frame.
 */
import type { HopPlaceView, HopTargetView } from "./app-types.ts";
import { truncateCells } from "./cells.ts";
import { oneLine } from "./commands.ts";
import { workloadText } from "./hop-command.ts";

/** The row while a hop has no phase yet (`moving to docker:box`). */
export function hopStatusLabel(target: string): string {
  return `moving to ${oneLine(target)}`;
}

/** The transient status row: `null` when no hop runs (the App then paints its
 * usual bar), else the phase exactly as the orchestrator worded it — its text
 * may come from an engine (`container-supplied`), so it is one line and cut.
 */
export function hopStatusRow(
  target: string | null,
  phase: string | null,
  columns: number,
): string | null {
  if (target === null) {
    return null;
  }
  const text = phase !== null && phase.trim() !== "" ? phase : hopStatusLabel(target);
  return truncateCells(oneLine(text), Math.max(10, columns));
}

/**
 * The cwd the footer and a tool ask show: the daemon session's OWN cwd after
 * a hop (`/` in an attached pod whose folder is not shared), else the laptop's
 * (docs/fix/session-hop-live.md D4). A relative `/attach` path still means the
 * laptop's — that one never comes from here.
 */
export function hopShownCwd(view: HopTargetView | null, laptopCwd: string): string {
  return view?.cwd ?? laptopCwd;
}

/** The place as one line (`local`, `docker:box`, `kubernetes:<ns>/web-0/app`). */
export function hopPlaceText(place: HopPlaceView): string {
  if (place.kind === "local") {
    return "local";
  }
  // ONE label (OD1): the badge, the notices and the prompt cannot disagree, and a
  // k8s pod is never printed as `kubernetes:<pod>/<container>` (which now reads as
  // `ns/pod`). A pod-supplied name is one line inside it (`workloadText`).
  return workloadText(place);
}

/**
 * The one line a finished hop leaves in the transcript (D3/D9, docs/feat/session-hop-ux
 * OD5/OD6): where the session is now, and what happens next. OD5 reversed D9 —
 * auto-accept SURVIVES a move — so this line no longer claims it is off; instead
 * it says whether the session CONTINUES by itself (OD6's wake) or waits for the
 * user to send a message. The words are the App's, never the engine's: `place` is
 * the host's own text for the resolved target.
 */
export function hopMovedNotice(
  place: string,
  autoAcceptWasOn: boolean,
  note?: string,
  continues = false,
  autoAccepted = false,
): string {
  const where = noticeText(oneLine(place));
  // OD4: logged allow-once — no prompt was shown, so the record says it.
  const how = autoAccepted ? " (auto-accepted)" : "";
  const after =
    note === undefined || note.trim() === "" ? how : `${how} — ${noticeText(oneLine(note))}`;
  // OD5: the MODE is a fact of the TUI, not of the hop; naming it keeps the
  // status bar and the transcript from ever disagreeing (a moved TUI keeps it on).
  const mode = autoAcceptWasOn ? "auto-accept on" : "auto-accept off";
  return continues
    ? `_Moved to ${where}${after} — continuing (${mode})._`
    : `_Moved to ${where}${after} — send a message to continue (${mode})._`;
}

/**
 * Text that goes inside the App's `_…_` notice, escaped so it renders
 * literally: it may be an engine's (`Docker API GET /_ping failed`), and an
 * unescaped `_`/`*`/`` ` ``/`[` would be read as markdown
 * (docs/fix/session-hop-live.md D2). The identity on text without them.
 */
export function noticeText(raw: string): string {
  return raw.replace(/[\\_*`[\]]/g, (c) => `\\${c}`);
}

/**
 * One line for a rejection that escaped the hop feed. `HopRun.done` is
 * contracted never to reject, so this is the belt-and-braces path (a host bug
 * must still leave a readable line and a released latch, never a stuck view).
 * The text may be an engine's, so it is one line.
 */
export function hopFailureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === "" ? "not moved: the hop failed" : `not moved: ${oneLine(message)}`;
}
