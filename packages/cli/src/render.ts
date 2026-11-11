/**
 * Pure renderer: turns an `AgentEvent` into the text to write to the terminal.
 * Kept side-effect-free so it is trivially testable; the main loop just writes
 * whatever it returns.
 */
import type { AgentEvent } from "@tentacle/agent";
import {
  type TruncationReason,
  describeEmptyTurn,
  describeRepairs,
  describeTruncation,
  toolLabel,
} from "@tentacle/core";

export function render(event: AgentEvent): string {
  switch (event.type) {
    case "text":
      return event.delta;
    case "reasoning":
      // Hidden by default in F1; a verbose mode will surface it later.
      return "";
    case "tool_start":
      return `\n[tool] ${event.name} ${event.arguments}\n`;
    case "tool_result": {
      // H1: a hook's intervention, as in the TUI; a block shows only its reason.
      const hook = event.result.hook;
      if (hook?.action === "blocked") {
        const reason = hook.reason ? `${hook.reason.replace(/\n+$/, "")}\n` : "";
        return `[hook] ${hook.name} blocked ${toolLabel(event.name)}\n${reason}`;
      }
      const note = hook ? `[hook] ${hook.name} modified ${toolLabel(event.name)} input\n` : "";
      const details = event.result.details;
      if (details?.kind === "diff") {
        return `${note}[diff] ${details.path} (+${details.added} -${details.removed})\n`;
      }
      return `${note}[result:${event.result.isError ? "error" : "ok"}] ${firstLine(event.result.content)}\n`;
    }
    case "usage":
      return "";
    case "subagent_start":
      return `  └─ ${event.agentType}: ${event.description}\n`;
    case "subagent_tool":
      return `     ${event.label}\n`;
    case "subagent_usage":
    case "tool_phase":
      return "";
    case "subagent_end":
      return `  └─ done (${event.toolUses} tool ${event.toolUses === 1 ? "use" : "uses"})\n`;
    case "background_exit": {
      const code = event.exitCode !== null ? ` (exit=${event.exitCode})` : "";
      return `\n[background] job ${event.jobId} ${event.status}${code}: ${event.command}\n`;
    }
    case "steer":
      return `\n› ${event.text}\n`;
    case "history_commit":
      return "";
    case "context_reset":
      return "\n↻ context reset by the model\n";
    case "context_note":
      // A user hook's note is shown (R1); the loop's own notes are not.
      return event.reason === "hook" ? `\n${event.text}\n` : "";
    case "dsml_leak":
      // The reply was refused as a leaked tool call and the model re-asked: the
      // user must know why their answer was dropped (docs/fix/deepseek-dsml-leak.md).
      return `\n${event.text}\n`;
    case "truncated_reply":
      // A partial answer is never presented as a complete one. `AnswerSplit`
      // owns the per-turn dedupe and the "was anything shown?" fact, so this
      // arm (the raw per-event renderer) names the conservative case.
      return `\n[truncated] ${describeTruncation(event.reason, { answered: true, retrying: event.reason === "length" })}\n`;
    case "empty_turn":
      // The turn produced nothing: on stderr with the rest of the trace, so
      // stdout stays clean data while the user still learns why.
      return `\n[empty turn] ${describeEmptyTurn()}\n`;
    case "history_repaired":
      // Once per session: the model was sent a repaired copy, the saved
      // session is unchanged (docs/feat/history-validity-invariant.md).
      return `\n${describeRepairs(event)}\n`;
    case "turn_end":
      return event.reason === "end_turn" ? "\n" : `\n[stopped: ${event.reason}]\n`;
  }
}

/**
 * The `[truncated]` trace line, with the ONE fact the renderer cannot know:
 * whether this turn had already written an answer (docs/fix/truncated-reply-silent.md).
 */
export function truncationNotice(reason: TruncationReason, answered: boolean): string {
  return `\n[truncated] ${describeTruncation(reason, {
    answered,
    retrying: reason === "length",
  })}\n`;
}

/**
 * Tracks whether the cursor is at the start of a line after `chunk` was
 * written (an empty chunk changes nothing).
 */
export function atLineStartAfter(was: boolean, chunk: string): boolean {
  return chunk === "" ? was : chunk.endsWith("\n");
}

/**
 * The `[error]` line for a failure mid-stream: on its own line, never glued to
 * streamed text, and no blank line when the cursor is already at a line start.
 */
export function errorLine(error: unknown, atLineStart: boolean): string {
  return `${atLineStart ? "" : "\n"}[error] ${String(error)}\n`;
}

/** What one event writes to each stream: `out` (stdout, the answer), `err` (stderr, the trace). */
export interface SplitChunk {
  readonly out: string;
  readonly err: string;
}

/**
 * A run's events split between the two streams (docs/fix/cli-output-streams.md
 * D5), for the one-shot and the plain REPL: the ANSWER — the model's text — on
 * stdout, everything else (`[tool]`, `[result]`, tokens, `[hook]`, `[diff]`,
 * subagent lines, `[stopped]`, `[error]`) on stderr, always. Pure: `push` says
 * what to write (`out` first, then `err`); one instance per turn.
 *
 * stdout stays clean data: two answer parts separated by a trace never glue
 * (a `\n` when stdout is mid-line), the run's end terminates a mid-line answer,
 * and an answer-less run writes nothing there.
 */
export class AnswerSplit {
  /** The shared screen's cursor (both streams on one terminal): `errorLine`'s placement. */
  private atLineStart = true;
  /** stdout's own cursor. */
  private outAtLineStart = true;
  /** stderr's own cursor. */
  private errAtLineStart = true;
  /** A trace was written since the last answer text. */
  private traced = false;
  /**
   * The `history_repaired` notice was already shown. Once per session: the
   * one-shot CLI has no daemon-side dedup, and the Agent yields one notice per
   * repaired round (docs/feat/history-validity-invariant.md).
   */
  private repairNoticed = false;
  /**
   * A `truncated_reply` notice was already shown for THIS turn. The reducer's
   * own rule, one layer up (docs/fix/truncated-reply-silent.md): a re-asked
   * round cuts again and repeats its cause, and the user needs the fact once.
   * Reset by `turn_end`, so the next turn may say it again.
   */
  private truncationNoticed = false;
  /** Whether this turn's model text reached stdout (see `truncationNoticed`). */
  private turnAnswered = false;

  /**
   * `shared`: stdout and stderr are the SAME terminal, so the answer moves the
   * cursor a trace starts from. Otherwise (stdout redirected) stderr's cursor
   * is its own and the answer never affects it.
   */
  constructor(private readonly shared = false) {}

  /** The cursor a stdout write starts from (a shared screen: a trace may have ended the line). */
  private get outCursorAtLineStart(): boolean {
    return this.shared ? this.atLineStart : this.outAtLineStart;
  }

  /** The cursor a stderr write starts from. */
  private get errCursorAtLineStart(): boolean {
    return this.shared ? this.atLineStart : this.errAtLineStart;
  }

  push(event: AgentEvent): SplitChunk {
    let out = "";
    let err = "";
    if (event.type === "text") {
      if (event.delta !== "") {
        out = `${this.traced && !this.outCursorAtLineStart ? "\n" : ""}${event.delta}`;
        this.traced = false;
        this.turnAnswered = true;
      }
    } else if (event.type === "turn_end") {
      out = this.outCursorAtLineStart ? "" : "\n";
      err = event.reason === "end_turn" ? "" : `[stopped: ${event.reason}]\n`;
      this.truncationNoticed = false;
      this.turnAnswered = false;
    } else {
      if (event.type === "history_repaired") {
        // Once per session: a later repaired round of the same run stays quiet.
        if (this.repairNoticed) {
          return { out: "", err: "" };
        }
        this.repairNoticed = true;
      }
      if (event.type === "truncated_reply") {
        // Once per TURN, and honest about whether an answer was on screen.
        if (this.truncationNoticed) {
          return { out: "", err: "" };
        }
        this.truncationNoticed = true;
        err = this.freshLine(truncationNotice(event.reason, this.turnAnswered));
        if (err !== "") {
          this.traced = true;
        }
        return { out, err };
      }
      err = this.freshLine(render(event));
      if (err !== "") {
        this.traced = true;
      }
    }
    this.outAtLineStart = atLineStartAfter(this.outAtLineStart, out);
    this.atLineStart = atLineStartAfter(atLineStartAfter(this.atLineStart, out), err);
    this.errAtLineStart = atLineStartAfter(this.errAtLineStart, err);
    return { out, err };
  }

  /**
   * A trace starts on a fresh line only when the cursor stderr writes from is
   * mid-line: `render`'s leading separator `\n` is dropped at a line start
   * (no stray blank line), and added when mid-line and absent (never glued).
   */
  private freshLine(text: string): string {
    if (text === "") {
      return text;
    }
    const lead = text.startsWith("\n");
    if (this.errCursorAtLineStart) {
      return lead ? text.slice(1) : text;
    }
    return lead ? text : `\n${text}`;
  }

  /** The `[error]` line (stderr) for a failure mid-run, on its own line of the stream's cursor. */
  error(error: unknown): string {
    return errorLine(error, this.errCursorAtLineStart);
  }
}

function firstLine(text: string): string {
  const newline = text.indexOf("\n");
  const line = newline === -1 ? text : text.slice(0, newline);
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}
