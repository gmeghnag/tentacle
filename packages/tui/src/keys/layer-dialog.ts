import { backgroundCount, backgroundNames } from "../background-view.ts";
import { ctrlCQuitStep } from "../commands.ts";
import { sanitizePasted, stepPaste } from "../paste.ts";
import { stepPermissionKey } from "../permission-reply.ts";
/**
 * The dialog layers (docs/feat/app-decomposition.md S3): the permission prompt,
 * Ctrl+C, and bracketed paste — in that precedence order, which is load-bearing:
 *
 * - **permission** — while the dialog is up, keys drive IT and nothing else.
 *   Inside the reply field a bracketed paste goes to the field (never the hidden
 *   main input, never read as `y`/`n`). Everything else is
 *   `stepPermissionKey`'s decision (`permission-reply.ts`); this only maps it to
 *   effects. Ctrl+C there is "stop the turn", not "deny".
 * - **ctrlC** — `ctrlCQuitStep` (`commands.ts`): an idle Ctrl+C with background
 *   children or jobs asks before losing them. It reads the LIVE refs (a child
 *   that finished this tick is not lost by a stale frame).
 * - **paste** — bracketed paste is captured BEFORE the escape-abort layers,
 *   because a paste's leading ESC can look like Escape. Runs idle or mid-turn,
 *   so text can be pasted into a queued task too.
 */
import type { KeyLayer, LayerStep } from "./contract.ts";
import { consumed } from "./contract.ts";
import type { KeyEffect } from "./effects.ts";

/** 4. The permission dialog owns every key while it is up. */
export const permissionLayer: KeyLayer = {
  name: "permission",
  step: (snap): LayerStep => {
    if (snap.permission.pending === null) {
      return { effects: [], verdict: "pass", carry: "" };
    }
    const mode = snap.permission.mode();
    // The open reply field takes a bracketed paste (sanitized, clipped), never
    // the hidden main field, and never read as y/n keys.
    if (mode.mode === "reply") {
      const paste = stepPaste(snap.pasteBuffer(), snap.char);
      if (paste.consumed) {
        const effects: KeyEffect[] = [
          { kind: "setPasteBuffer", buffer: paste.buffer },
          paste.buffer !== null ? { kind: "armPasteTimeout" } : { kind: "clearPasteTimeout" },
        ];
        if (paste.text !== undefined) {
          const clean = sanitizePasted(paste.text);
          if (clean !== "") {
            // The App inserts through `insertReply` (it clips to the request's
            // `maxChars`); the pure layer only decides WHAT text and WHERE.
            effects.push({ kind: "insertReply", text: clean });
          }
        }
        return { effects, verdict: "consumed", carry: "" };
      }
    }
    const { state, action } = stepPermissionKey(mode, snap.char, snap.key, {
      choices: snap.permission.choices,
      selected: snap.permission.selected,
      maxChars: snap.replyMaxChars,
    });
    const effects: KeyEffect[] = [];
    if (state !== mode) {
      effects.push({ kind: "setReplyMode", mode: state });
    }
    switch (action.kind) {
      case "stop":
        // "Stop everything", not "I refuse this command": no deny goes out (over
        // RPC it would race the cancel and show a false "denied" on every device).
        effects.push({ kind: "permissionStop" });
        break;
      case "select":
        effects.push({ kind: "permissionSelect", index: action.index });
        break;
      case "answer":
        effects.push({ kind: "permissionAnswer", response: action.response });
        break;
      case "pasteClipboard":
        effects.push({ kind: "pasteReply" });
        break;
      default:
        break;
    }
    return { effects, verdict: "consumed", carry: "" };
  },
};

/** 5. Ctrl+C: one decision (`ctrlCQuitStep`), read from the live refs. */
export const ctrlCLayer: KeyLayer = {
  name: "ctrlC",
  step: (snap): LayerStep => {
    if (!(snap.key.ctrl && snap.char === "c")) {
      return { effects: [], verdict: "pass", carry: "" };
    }
    const agents = backgroundCount(snap.subagents());
    const others = snap.othersOnSession();
    const jobs = snap.detachOnQuit ? 0 : snap.jobRows().length;
    const step = ctrlCQuitStep({
      running: snap.running(),
      exitPending: snap.exitPending(),
      detaches: snap.detachOnQuit,
      others,
      agents,
      jobs,
    });
    if (step === "confirm") {
      return consumed({
        kind: "setQuitConfirm",
        facts: { others: 0, agents, jobs, names: backgroundNames(snap.subagents()) },
      });
    }
    // No abort handle (the turn is already settling) → nothing to stop: quit.
    if (step === "exit" || !snap.abortable()) {
      return consumed({ kind: "exit" });
    }
    return consumed({ kind: "abortTurn" });
  },
};

/** 6. Bracketed paste, before the escape-abort layers (a paste's ESC is not Esc). */
export const pasteLayer: KeyLayer = {
  name: "paste",
  step: (snap): LayerStep => {
    const paste = stepPaste(snap.pasteBuffer(), snap.char);
    if (!paste.consumed) {
      return { effects: [], verdict: "pass", carry: "" };
    }
    const effects: KeyEffect[] = [
      { kind: "setPasteBuffer", buffer: paste.buffer },
      // Still inside a paste → arm the recovery timer; finished → disarm it.
      paste.buffer !== null ? { kind: "armPasteTimeout" } : { kind: "clearPasteTimeout" },
    ];
    if (paste.text !== undefined) {
      const clean = sanitizePasted(paste.text);
      // An open reply field takes it, never the hidden main field; behind a
      // panel the (hidden) input takes nothing.
      if (clean !== "" && snap.panel === null) {
        effects.push({ kind: "routeAttach", text: clean });
      }
    }
    return { effects, verdict: "consumed", carry: "" };
  },
};
