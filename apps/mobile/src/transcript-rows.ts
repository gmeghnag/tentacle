/**
 * The transcript's row types — separate from `transcript.ts`'s fold so the
 * history mapper (`transcript-history.ts`) and the fold share one definition
 * without a cycle.
 */
import type {
  AttachmentRef,
  MessageMedia,
  ScheduledRef,
  ToolDiffDetail,
  ToolResult,
} from "@tentacle/core";
import type { ArtifactMeta, DocumentContent } from "@tentacle/protocol";

/** A tool row's status: the TUI's four, plus the person's own reply-refusal. */
export type ToolStatus = "queued" | "running" | "ok" | "error" | "denied";

/** An image a prompt named, as the transcript carries it (`media_message` refs). */
export type ImageRef = Pick<AttachmentRef, "id" | "mimeType" | "size"> & {
  readonly name?: string;
  /**
   * A LOCAL copy of these bytes, when this phone has one (fix/mobile-media-live
   * item 2): the file it just uploaded, so the bubble shows the photo it sent
   * instead of a placeholder. Absent for a history row, another device's
   * message, or any ref the daemon alone knows — there is no read-back method
   * (`thumbnails.ts:19-25`), so no other source exists.
   */
  readonly localUri?: string;
  /** The local copy's aspect ratio (w/h), when it is known: the bubble's shape. */
  readonly aspectRatio?: number;
};

export interface UserRow {
  readonly kind: "user";
  /** Stable across updates: a virtualised list keys on it. */
  readonly key: string;
  readonly text: string;
  /**
   * When this message ARRIVED (epoch ms; docs/fix/mobile-open-at-end.md, slice
   * B), shown by the row's swipe. Absent = not known — an older daemon, a
   * message a reload re-logged (`times[i]` 0), a notice, or a live row folded
   * with no clock. Never `0` itself: the fold never stores a `0`.
   */
  readonly at?: number;
  /** The prompt's images (rendered as `[image: name]`, plan Owner requirement). */
  readonly images: readonly ImageRef[];
  /**
   * The prompt's attached files, one `[pdf: name · N pp]` line each
   * (docs/feat/pdf-read.md D5/D7), after the images — the `<file>` block they
   * became is NEVER shown (the model has that text, the person has the file).
   * Absent for a message that carried none, and for a stored one whose `media`
   * this build was never told about (the raw text then stands: honest
   * degradation, never a guess).
   */
  readonly documents?: readonly string[];
  /** The model's restart prompt after a context reset (labelled "restart prompt"). */
  readonly restart?: true;
  /**
   * The scheduled wake that started this turn (docs/feat/scheduled-fire-row.md):
   * live, the `turn_start.schedule` ref the client trust-gated and sanitized
   * (`client/schedules.ts` `firedScheduleRef`); reloaded, the stored
   * `ChatMessage.scheduled` — the same record, so the `◷ Wake 15:54` node is
   * the same. Absent for an ordinary prompt and an older daemon or log: the
   * node then reads the durable `[scheduled …]` prefix in `text`
   * (`firedRowView`).
   */
  readonly schedule?: ScheduledRef;
}

export interface AssistantRow {
  readonly kind: "assistant";
  readonly key: string;
  readonly text: string;
  /** As `UserRow.at`: the arrival time, when one is known. */
  readonly at?: number;
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
  /**
   * The arrival time of the assistant message that LISTED this call — never its
   * result's (the result is folded onto this row, and a restamp would move the
   * label each time a delta of that message arrived).
   */
  readonly at?: number;
  /** The tool's name, as the model called it. */
  readonly name: string;
  /** The display label (`toolLabel`). */
  readonly label: string;
  readonly args: string;
  readonly status: ToolStatus;
  /** The result text: collapsed on screen until tapped. */
  readonly output?: string;
  /** A file diff, when the tool produced one (live only, plan P7). */
  readonly diff?: ToolDiffDetail;
  /**
   * The artifact this call presented (docs/feat/model-artifacts.md D9): LIVE, from
   * the tool result's own `details` — the present call's answer, never a guess. A
   * row rebuilt from history carries none (the `ChatMessage` holds no details); the
   * screen joins those onto `artifact/list` by call id (`artifact-join.ts`).
   */
  readonly artifact?: ArtifactMeta;
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
  /**
   * The tentacle note it was drawn from (`ChatMessage.note`): the Activity
   * sheet joins a sub-agent's report by its `id` (`activity-memory.ts`).
   */
  readonly note?: { readonly kind: string; readonly id?: string };
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

/**
 * A user row's document line, the `[image: name]` shape: `[pdf: report.pdf · 2 pp]`
 * when the page count is known, `[pdf: report.pdf]` when it is not (a PDF this
 * phone attached: the count is the daemon's fact and the client never sees it
 * on the turn). The SAME wording as the TUI's `documentRowText`
 * (`packages/tui/src/pdf-attach.ts`), pinned to it by `test/transcript-pdf.test.ts`.
 */
export function documentRowText(name: string, pages?: number): string {
  return pages === undefined || pages <= 0 ? `[pdf: ${name}]` : `[pdf: ${name} · ${pages} pp]`;
}

/**
 * One stored `media` entry as a row (`ChatMessage.media`, D4): the `[pdf: …]`
 * line above, or a plain `[kind: name]` for a kind this build does not know
 * (the field is a bounded free string on the wire — a newer daemon's entry is
 * still a fact about the message, never silently dropped).
 */
export function mediaRowText(media: MessageMedia): string {
  return media.kind === "pdf"
    ? documentRowText(media.name, media.pages)
    : `[${media.kind}: ${media.name}]`;
}

/**
 * The rows for the documents a prompt carries, in its own order (D7). The page
 * count is only known when the CLIENT extracted (`document{text}`, a pod): an
 * uploaded PDF's count is the daemon's fact, and this phone never sees it on the
 * turn — so the row names the file and invents nothing, and the count appears
 * on RESUME from `ChatMessage.media`.
 */
export function documentLabels(documents: readonly DocumentContent[]): readonly string[] {
  return documents.map((document) =>
    documentRowText(
      document.name,
      document.source.type === "text" ? document.source.pages : undefined,
    ),
  );
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

/**
 * The local copy of one image this phone sent (item 2): the file it uploaded,
 * with the size the picker reported. The transcript's row carries it so the
 * bubble draws the photo it sent — the daemon offers no read-back, so this is
 * the only source of pixels for a fresh send.
 */
export interface LocalPhoto {
  /** The `AttachmentRef.id` this file's bytes became. */
  readonly id: string;
  /** The sandbox copy's URI (`photo-source.ts`'s `copyInto`). */
  readonly uri: string;
  readonly width?: number;
  readonly height?: number;
}

/** `ref`'s row-shaped image, with its local copy attached when this phone has one. */
export function imageRefWithLocal(ref: AttachmentRef, local: LocalPhoto | undefined): ImageRef {
  const base = imageRef(ref);
  if (local === undefined || local.id !== ref.id) {
    return base;
  }
  const ratio =
    local.width !== undefined && local.height !== undefined && local.height > 0
      ? local.width / local.height
      : undefined;
  return {
    ...base,
    localUri: local.uri,
    ...(ratio === undefined ? {} : { aspectRatio: ratio }),
  };
}
