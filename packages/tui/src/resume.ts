/**
 * Turn a resumed conversation (the model's `ChatMessage[]`) back into the
 * display transcript, so `--resume` shows the prior turns, not a blank screen.
 * The agent history remains the source of truth; this is a presentation view.
 */
import { restartPromptOf } from "@tentacle/agent";
import {
  COMPACTION_SUMMARY_HEAD,
  type ChatMessage,
  compactionOf,
  compactionSeparatorText,
} from "@tentacle/core";
import type { ArtifactMeta } from "@tentacle/protocol";
import { joinKnownArtifacts } from "./artifacts-panel.ts";
import { imageRowText } from "./attach-draft.ts";
import { userMessageView } from "./pdf-attach.ts";
import type { DisplayItem, ToolItem } from "./state.ts";

/**
 * The separator before a context reset's restart prompt (decision 9, docs/eval/context-reset.md).
 */
export const CONTEXT_RESET_SEPARATOR = "↻ context reset by the model";

/**
 * A compaction's summary message as the separator rule (docs/feat/harness-notices.md
 * S3.4, owner Q3): the rule at the compaction point, the brief as its `body`
 * (shown only with Ctrl+O). It used to project to a `›` user row carrying the
 * whole summary — something the person never typed. A summary with no brief
 * beyond the head gets no body (an empty `<Text>` measures 0×0, AGENTS §6).
 */
function compactionItem(m: ChatMessage): DisplayItem {
  const view = compactionOf(m) ?? {};
  const brief = m.content.slice(COMPACTION_SUMMARY_HEAD.length).trim();
  return {
    kind: "notice",
    text: compactionSeparatorText(view),
    separator: true,
    ...(brief === "" ? {} : { body: brief }),
  };
}

/**
 * A tentacle-written note (a job's exit, a sub-agent's report/loss) as a
 * NOTICE, never as a row the person typed: the first line is the notice's
 * text, the rest is its `body` (shown only when expanded). An unknown kind is a
 * plain notice of the first line, so a newer `note.kind` never breaks a resume.
 */
function noteItem(m: ChatMessage): DisplayItem {
  const [first = "", ...rest] = m.content.split("\n");
  const body = rest.join("\n").trim();
  return {
    kind: "notice",
    text: first,
    ...(body !== "" ? { body } : {}),
    ...(m.note !== undefined ? { noteKind: m.note.kind } : {}),
  };
}

/**
 * A restart message (a context reset's first user message) is shown as the
 * separator, then the model's prompt alone — tentacle's appended notes
 * (jobs, skills) are the model's, not the user's.
 *
 * `artifactsByCall` (docs/feat/model-artifacts.md D8) is the daemon's
 * `artifact/list`, keyed by the `present` call that produced each version: a
 * reloaded transcript carries no `details` (they are not in `ChatMessage`), so
 * the card's metadata can only come from there. Absent → the rows stay plain,
 * exactly as before; the MAP ITSELF is the App's `ArtifactJoin` ref, so what it
 * learns here is still there for the next history replace (S6a review finding 2).
 */
/** The card map a history rebuild joins through (`ArtifactJoin.byCall`). */
export type ArtifactCardMap = ReadonlyMap<string, ArtifactMeta>;

export function messagesToItems(
  messages: readonly ChatMessage[],
  artifactsByCall?: ReadonlyMap<string, ArtifactMeta>,
): DisplayItem[] {
  return itemsOf(messages, artifactsByCall);
}

function itemsOf(
  messages: readonly ChatMessage[],
  artifactsByCall?: ReadonlyMap<string, ArtifactMeta>,
): DisplayItem[] {
  const items: DisplayItem[] = [];
  const toolAt = new Map<string, number>(); // toolCallId → index in `items`

  for (const m of messages) {
    if (m.role === "system") {
      continue; // the system prompt is not part of the visible transcript
    }
    if (m.role === "user") {
      const restart = restartPromptOf(m.content);
      const compaction = compactionOf(m);
      if (restart !== null) {
        items.push({ kind: "notice", text: CONTEXT_RESET_SEPARATOR, separator: true });
        items.push({ kind: "user", text: restart, restart: true });
      } else if (compaction !== null) {
        items.push(compactionItem(m));
      } else if (m.note !== undefined) {
        items.push(noteItem(m));
      } else {
        // A resumed attachment prompt says so: `[image: name]` under the text, and
        // the ONLY rows of an image-only prompt (docs/feat/attachments-tui.md D7).
        // A PDF (docs/feat/pdf-read.md D5) is the same idea one field over: the
        // `media` chip the daemon persisted, and the `<file>` block HIDDEN — the
        // model has that text, the user has the file. Without `media` (an older
        // log) `userMessageView` returns the content RAW, which is the honest
        // degradation: a build cannot guess which block was a PDF.
        const images = (m.attachments ?? []).map(imageRowText);
        const view = userMessageView(m.content, m.media);
        const documents = view.rows;
        items.push({
          kind: "user",
          text: view.text,
          ...(images.length > 0 ? { images } : {}),
          ...(documents.length > 0 ? { documents } : {}),
          // A fired wake's record (docs/feat/scheduled-fire-row.md): the same
          // `schedule` a live turn's ref gives, so the row is identical.
          ...(m.scheduled !== undefined ? { schedule: m.scheduled } : {}),
        });
      }
    } else if (m.role === "assistant") {
      if (m.content.trim() !== "") {
        items.push({ kind: "assistant", text: m.content });
      }
      for (const call of m.toolCalls ?? []) {
        toolAt.set(call.id, items.length);
        items.push({
          kind: "tool",
          id: call.id,
          name: call.name,
          args: call.arguments,
          status: "ok", // historical: the call already ran
        });
      }
    } else if (m.role === "tool") {
      const idx = m.toolCallId !== undefined ? toolAt.get(m.toolCallId) : undefined;
      const tool = idx !== undefined ? (items[idx] as ToolItem) : undefined;
      if (tool) {
        items[idx as number] = {
          ...tool,
          resultText: m.content,
          // A refused call is known from its reply; any other result's error flag is not stored.
          status: m.denialReply !== undefined ? "error" : "ok",
          // A spilled result shows the same note as live (docs/feat/tui-spill-note.md).
          ...(m.spill ? { spill: m.spill } : {}),
          // So does a refusal with a reply (docs/feat/permission-reply.md).
          ...(m.denialReply !== undefined ? { denialReply: m.denialReply } : {}),
          // The stored measurement, or none: never a fake 0.0s (docs/fix/tool-duration.md).
          ...(m.durationMs !== undefined ? { durationMs: m.durationMs } : {}),
        };
      } else {
        // A tool result with no matching call (truncated history): show it plainly.
        items.push({ kind: "notice", text: m.content });
      }
    }
  }
  return artifactsByCall === undefined ? items : [...joinKnownArtifacts(items, artifactsByCall)];
}
