/**
 * The input's image draft: chips, the one upload in flight, and what Enter does
 * with them (docs/feat/attachments-tui.md D6).
 *
 * Everything here is a decision, so it is pure and React-free (AGENTS §7): the
 * App only EXECUTES what these functions return — it inserts text, appends a
 * chip, shows a notice, sends with refs, or refuses. Every failure mode of the
 * task doc's table lands in exactly one of those, which is why it is testable
 * without a terminal.
 *
 * The detection itself is 3a's: `attachmentCandidateText` (is this paste only
 * paths?), `decideAttachment` (sniff, caps, refusals — needs the disk, so it
 * stays outside) and `refusalText`. This module never reads a file.
 */
import { MAX_ATTACHMENTS_PER_MESSAGE, formatBytes } from "@tentacle/core";
import { attachmentCandidateText } from "./attach-candidates.ts";
import type { AttachedImage } from "./attach-files.ts";
import { type AttachRefusal, claimsImagePath, refusalText } from "./attach-refusal.ts";

/**
 * What the input box holds besides its text: the chips (each with the bytes a
 * submit uploads) and, while an upload runs, which one and how far it got.
 */
export interface AttachDraft {
  readonly chips: readonly AttachedImage[];
  readonly upload: null | {
    /** 0-based chip index, `count` chips in this submit. */
    readonly index: number;
    readonly count: number;
    readonly name: string;
    readonly sent: number;
    readonly size: number;
  };
}

export const EMPTY_DRAFT: AttachDraft = { chips: [], upload: null };

/** What this session may do with an image (structurally `ImageInput`; the TUI does not depend on the client). */
export type AttachMode =
  | { readonly kind: "upload" | "laptop"; readonly maxBytes: number }
  | { readonly kind: "off"; readonly reason: string };

/** What the session said it can do, or the reason a session with no seam gives. */
export const NO_IMAGE_SEAM: AttachMode = {
  kind: "off",
  reason: "this session does not take images",
};

/** A decision (`attach-files.ts`'s `AttachmentDecision`), as this module consumes it. */
export type AttachDecision =
  | {
      readonly kind: "attachments";
      readonly images: readonly AttachedImage[];
      readonly refusals: readonly AttachRefusal[];
    }
  | { readonly kind: "text" }
  | { readonly kind: "refused"; readonly refusals: readonly AttachRefusal[] };

/** What a decision does to the input: the draft, text to insert, and what to say. */
export interface RouteResult {
  readonly draft: AttachDraft;
  /** Text to insert at the cursor — only a `text` decision inserts anything. */
  readonly insert?: string;
  /** One line per refusal (or the ONE reason images are off), in the order read. */
  readonly notices: readonly string[];
}

/**
 * Apply a decision to the draft. `text` pasted text still becomes text; images
 * become chips (and their refusals notices); with images OFF nothing is
 * attached and nothing is inserted — the user is told WHY (decision 10), and a
 * path never silently becomes prompt text.
 */
export function routeDecision(
  draft: AttachDraft,
  decision: AttachDecision,
  mode: AttachMode,
  text = "",
): RouteResult {
  if (decision.kind === "text") {
    return { draft, ...(text !== "" ? { insert: text } : {}), notices: [] };
  }
  if (mode.kind === "off") {
    // ONE notice: the mode's own sentence, then any refusal that explains a file.
    return { draft, notices: [offNotice(mode.reason), ...decision.refusals.map(refusalText)] };
  }
  if (decision.kind === "refused") {
    return { draft, notices: decision.refusals.map(refusalText) };
  }
  return {
    draft: withChips(draft, decision.images).draft,
    notices: decision.refusals.map(refusalText),
  };
}

/** `_<reason>_`: the italic shape every notice row uses. */
const offNotice = (reason: string): string => `_images are off: ${reason}_`;

/**
 * Append chips, honouring the per-message cap for the whole MESSAGE (the
 * decision counted it already, so this is a guard against a race between two
 * pastes: the extra ones are reported, never silently dropped).
 */
export function withChips(
  draft: AttachDraft,
  images: readonly AttachedImage[],
): { readonly draft: AttachDraft; readonly overCap: number } {
  const room = Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - draft.chips.length);
  const kept = images.slice(0, room);
  if (kept.length === 0) {
    return { draft, overCap: images.length };
  }
  return {
    draft: { ...draft, chips: [...draft.chips, ...kept] },
    overCap: images.length - kept.length,
  };
}

/** Backspace on an EMPTY input: the last chip goes (decision 13). */
export function removeLastChip(draft: AttachDraft): AttachDraft {
  if (draft.chips.length === 0) {
    return draft;
  }
  return { ...draft, chips: draft.chips.slice(0, -1) };
}

/** The draft as it is while chip `index` of `count` uploads (`sent` of `size` bytes). */
export function uploadProgress(
  draft: AttachDraft,
  index: number,
  count: number,
  name: string,
  sent: number,
  size: number,
): AttachDraft {
  return { ...draft, upload: { index, count, name, sent, size } };
}

/** No upload in flight (it ended, succeeded or not). */
export function uploadDone(draft: AttachDraft): AttachDraft {
  return draft.upload === null ? draft : { ...draft, upload: null };
}

/** The refs a submit sends, in chip order. */
export function draftRefs(draft: AttachDraft): readonly AttachedImage["ref"][] {
  return draft.chips.map((chip) => chip.ref);
}

/** What Enter does, decided once (never re-derived in the App). */
export type SubmitPlan =
  /** Send this text with these chips' refs (the text may be `""` when chips exist). */
  | { readonly kind: "send"; readonly text: string; readonly images: readonly AttachedImage[] }
  /** The input is only image PATHS: become chips, send nothing (decision 5). */
  | { readonly kind: "convert" }
  /** Refused, with the reason: the text and the chips stay where they are. */
  | { readonly kind: "refuse"; readonly notice: string }
  /** No chips and not only paths: today's path (queue, command, send). */
  | { readonly kind: "text" };

export interface SubmitInput {
  readonly text: string;
  readonly draft: AttachDraft;
  /** A turn of mine (or another device's) is running. */
  readonly running: boolean;
  /** This TUI's `/compact` is running. */
  readonly compacting: boolean;
  /** The dock targets an open child (its text is the child's). */
  readonly dockOpen: boolean;
  readonly mode: AttachMode;
  /** `attachmentCandidateText(text).kind === "paths"` for this text. */
  readonly onlyPaths: boolean;
}

/** Enter while an upload runs: nothing new starts (the upload's own send follows). */
export const UPLOADING_NOTICE =
  "_an image is still uploading — wait for it to finish, or press Esc to cancel_";

/**
 * A typed drag whose bytes turned out NOT to be an image: the text goes back to
 * the input and says why, so nothing is silently swallowed — and the next Enter
 * sends it as a message instead of probing the disk again.
 */
export const NOT_AN_IMAGE_NOTICE =
  "_that is not an image — the text is kept; Enter again sends it as a message_";

/**
 * Enter's plan. Enter WITH chips is never queued: enqueue/steer are text-only
 * (2b decision 9), so dropping the images silently is the one thing forbidden —
 * the chips are refused and kept (decision 7). Images OFF with chips is a
 * refusal too: the mode changed under them (a reconnect), and the reason is the
 * honest answer instead of an upload that would fail at the seam.
 *
 * An upload in flight refuses EVERY Enter: the send that follows the upload is
 * already decided, so a second one would upload the same chips again and send
 * the prompt twice (review round 1, finding 2).
 */
export function submitPlan(input: SubmitInput): SubmitPlan {
  if (input.draft.upload !== null) {
    return { kind: "refuse", notice: UPLOADING_NOTICE };
  }
  if (input.draft.chips.length === 0) {
    return input.onlyPaths ? { kind: "convert" } : { kind: "text" };
  }
  if (input.mode.kind === "off") {
    return { kind: "refuse", notice: offNotice(input.mode.reason) };
  }
  if (input.running || input.compacting || input.dockOpen) {
    return {
      kind: "refuse",
      notice: "_can't send an image while a turn runs — the message is kept here (stop it first)_",
    };
  }
  return { kind: "send", text: input.text, images: input.draft.chips };
}

/** The one row the input box shows for the draft, or none. */
export type AttachRow =
  | { readonly kind: "chips"; readonly items: readonly string[]; readonly more: number }
  | { readonly kind: "upload"; readonly text: string };

/** ` +N` marker when more chips exist than fit. */
const MORE = (n: number): string => `+${n}`;

/**
 * Is this text a SLASH COMMAND rather than a dropped path?
 *
 * `/compact` alone is a legal path candidate (`tokenizePaths` cannot know
 * better), and so is the absolute `/tmp/a.png` a terminal just handed over. The
 * rule a user sees, and the one 3a's own refusal rule already rests on: a
 * command's first word does not NAME an image. A dragged file keeps its
 * extension in every terminal's form (macOS, iTerm2/Ghostty, kitty/VS Code), so
 * `/help`, `/deploy-app` and even the mis-typed `/deploy-app/x` stay commands,
 * while `/tmp/a.png` and `/Users/me/Shot 1.png` are paths the bytes decide on.
 */
export function looksLikeCommand(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed.startsWith("/")) {
    return false;
  }
  const [first = "", ...rest] = trimmed.split(/\s+/);
  if (claimsImagePath(first)) {
    return false;
  }
  // A bare word, or a command with arguments: a command. Several words whose
  // first one is itself a nested path (`/Users/me/Shot 1.png`) is a drag.
  return rest.length === 0 || !first.slice(1).includes("/");
}

/**
 * Is this text an unbracketed DRAG that Enter should probe — decision 5's
 * `convert`?
 *
 * Only paths, and at least one of them CLAIMS an image by its extension: the
 * same fact `looksLikeCommand` rests on (a dragged file keeps its extension in
 * every terminal's form). Without it a typed `~/notes.md` + Enter would clear
 * the field, probe the disk and say nothing — a sent message silently lost
 * (review round 1, finding 1). A path with no image extension keeps today's
 * meaning: text to send.
 */
export function imageDropOnly(text: string, options: { readonly home?: string } = {}): boolean {
  if (looksLikeCommand(text)) {
    return false;
  }
  const candidate = attachmentCandidateText(text, options);
  return candidate.kind === "paths" && candidate.paths.some(claimsImagePath);
}

/**
 * Enter's `onlyPaths`, with the ONE fact `imageDropOnly` cannot see: a text that
 * was already probed and came back `text` goes out as a message on the next
 * Enter. `probedText` is that text — `convertToChips` recorded it when it put
 * the text back with `NOT_AN_IMAGE_NOTICE`. Without this the notice lied: one
 * of the paths still claims an image, so Enter converted again, probed again,
 * decided `text` again and restored the text again — the message could never be
 * sent (review round 2, finding R2-1). A different text (`""` included) is
 * probed as usual: editing the drop makes it a new drop.
 */
export function enterConvertsToChips(
  text: string,
  probedText: string | null,
  options: { readonly home?: string } = {},
): boolean {
  if (text === probedText) {
    return false;
  }
  return imageDropOnly(text, options);
}

/**
 * The chip/upload row, in ONE line at most: chips as `name size`, truncated to
 * `width` with `+N` for the rest; while an upload runs its own text. `null`
 * when there is nothing to show — the caller then reserves no row (P8).
 */
export function attachRowView(draft: AttachDraft, width: number): AttachRow | null {
  const { upload } = draft;
  if (upload !== null) {
    const pct =
      upload.size === 0 ? 100 : Math.min(100, Math.floor((upload.sent / upload.size) * 100));
    return {
      kind: "upload",
      text: `uploading ${upload.name} ${pct}% (${upload.index + 1}/${upload.count})`,
    };
  }
  if (draft.chips.length === 0) {
    return null;
  }
  const items = draft.chips.map(chipLabel);
  const shown: string[] = [];
  let used = 0;
  for (const [i, item] of items.entries()) {
    const rest = items.length - i - 1;
    // Room for this chip, its separator, and a `+N` marker for what follows.
    const needed =
      used + item.length + (shown.length === 0 ? 0 : 2) + (rest > 0 ? MORE(rest).length + 1 : 0);
    if (shown.length > 0 && needed > width) {
      break;
    }
    shown.push(item);
    used += item.length + (shown.length === 1 ? 0 : 2);
  }
  return { kind: "chips", items: shown, more: items.length - shown.length };
}

/** `name size`, or the MIME type when the ref has no name. */
export function chipLabel(chip: AttachedImage): string {
  const name =
    chip.ref.name !== undefined && chip.ref.name !== "" ? chip.ref.name : chip.ref.mimeType;
  return `${name} ${formatBytes(chip.ref.size)}`;
}

/** How many rows the draft needs (0 or 1): what `inputBoxRows` adds (P8). */
export const attachRowRows = (draft: AttachDraft, width: number): number =>
  attachRowView(draft, width) === null ? 0 : 1;

/**
 * A user row's image line (owner's `[image: name]`, decision 6): the name when
 * the ref has one, else its MIME type. No sha prefix — that is the model's
 * summary (`compact.ts`), not the eye's.
 */
export function imageRowText(ref: {
  readonly mimeType: string;
  readonly name?: string;
}): string {
  const label = ref.name !== undefined && ref.name !== "" ? ref.name : ref.mimeType;
  return `[image: ${label}]`;
}

/** One sentence for an upload/refusal failure (matching by name/code/reason, never by message text). */
export function attachErrorText(error: unknown): string {
  if (typeof error !== "object" || error === null) {
    return error === undefined || error === null || error === ""
      ? "_the image could not be attached_"
      : `_attachment failed: ${String(error)}_`;
  }
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  const reason = (error as { data?: { reason?: unknown } }).data?.reason;
  const message = (error as { message?: unknown }).message;
  if (name === "UploadAbortedError") {
    return "_upload cancelled_";
  }
  if (code === -32016 /* AttachmentRefused */) {
    if (reason === "not_uploaded") {
      return "_the daemon no longer has these bytes — press Enter to upload them again_";
    }
    if (reason === "images_off") {
      return "_images are off for this session — nothing was sent_";
    }
    return `_the daemon refused the image: ${typeof message === "string" ? message : "invalid ref"}_`;
  }
  if (typeof message === "string" && message !== "") {
    return `_${message}_`;
  }
  return "_the image could not be attached_";
}

// Re-exported so callers do not reach past this module for the three shapes it owns.
export type { AttachedImage, AttachRefusal };
