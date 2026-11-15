/**
 * The transcript's row types — separate from `transcript.ts`'s fold so the
 * history mapper (`transcript-history.ts`) and the fold share one definition
 * without a cycle.
 */
import type { AttachmentRef, ToolResult, ToolResultDetail } from "@tentacle/core";

/** A tool row's status: the TUI's four, plus the person's own reply-refusal. */
export type ToolStatus = "queued" | "running" | "ok" | "error" | "denied";

/** An image a prompt named, as the transcript carries it (`media_message` refs). */
export type ImageRef = Pick<AttachmentRef, "id" | "mimeType" | "size"> & {
  readonly name?: string;
};

export interface UserRow {
  readonly kind: "user";
  /** Stable across updates: a virtualised list keys on it. */
  readonly key: string;
  readonly text: string;
  /** The prompt's images (rendered as `[image: name]`, plan Owner requirement). */
  readonly images: readonly ImageRef[];
  /** The model's restart prompt after a context reset (labelled "restart prompt"). */
  readonly restart?: true;
}

export interface AssistantRow {
  readonly kind: "assistant";
  readonly key: string;
  readonly text: string;
  /**
   * A monotonically growing token per text change (`text.length`: the deltas only
   * append), and what a markdown parse is cached on. Chosen over a counter so a
   * batched fold and an unbatched one produce IDENTICAL rows (`stream-batch` test).
   */
  readonly version: number;
}

export interface ReasoningRow {
  readonly kind: "reasoning";
  readonly key: string;
  readonly text: string;
  /** As `AssistantRow.version`: the text's length (append-only). */
  readonly version: number;
}

export interface ToolRow {
  readonly kind: "tool";
  readonly key: string;
  /** The call id (the screen's `tool-<id>-<status>` testID). */
  readonly id: string;
  /** The tool's name, as the model called it. */
  readonly name: string;
  /** The display label (`toolLabel`). */
  readonly label: string;
  readonly args: string;
  readonly status: ToolStatus;
  /** The result text: collapsed on screen until tapped. */
  readonly output?: string;
  /** A file diff, when the tool produced one (live only, plan P7). */
  readonly diff?: ToolResultDetail;
  readonly durationMs?: number;
  readonly hook?: ToolResult["hook"];
  readonly spill?: ToolResult["spill"];
  readonly denialReply?: string;
  /** A sub-agent's live progress, on its `agent_task` row (item 10). */
  readonly sub?: SubProgress;
}

/**
 * A foreground sub-agent's progress (the TUI's `SubAgentProgress`, minus what the
 * phone does not draw): without it a minutes-long child looks like a hang
 * (docs/fix/mobile-chat-glitches.md, item 10).
 */
export interface SubProgress {
  /** The latest activities (capped: the phone shows the last one). */
  readonly activities: readonly string[];
  readonly toolUses: number;
  readonly tokens: number;
  readonly done: boolean;
  readonly stopReason?: string;
  /** The child moved to the background: its agent id. */
  readonly movedTo?: string;
}

export interface NoticeRow {
  readonly kind: "notice";
  readonly key: string;
  readonly text: string;
  /** A longer body (a tentacle note's rest), shown only when expanded. */
  readonly body?: string;
  /** A full-width rule around the text (a context reset's separator). */
  readonly separator?: true;
}

/**
 * The running indicator. NOT a row: it sits under the transcript, so a
 * virtualised list's keys never shift when a turn starts or ends.
 */
export interface TurnRow {
  readonly kind: "turn";
  readonly key: string;
  readonly turnId: string;
  /** Started here or by another device: rendered and cancelled identically. */
  readonly own: boolean;
}

export type Row = UserRow | AssistantRow | ReasoningRow | ToolRow | NoticeRow;

/**
 * What a row shows for an image ref: `[image: name]` — the TUI's own wording
 * (`attach-draft.ts`'s `imageRowText`), pinned to it by the parity test, so the
 * two frontends name an image the same way. The screen may still draw a
 * thumbnail from the ref's `id`; this is only its label.
 */
export function imageRowText(ref: Pick<ImageRef, "mimeType" | "name">): string {
  const label = ref.name !== undefined && ref.name !== "" ? ref.name : ref.mimeType;
  return `[image: ${label}]`;
}

/** A protocol ref as `ImageRef` (the ref's own fields; nothing derived). */
export function imageRef(ref: AttachmentRef): ImageRef {
  return {
    id: ref.id,
    mimeType: ref.mimeType,
    size: ref.size,
    ...(ref.name !== undefined ? { name: ref.name } : {}),
  };
}
