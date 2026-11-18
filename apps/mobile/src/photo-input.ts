/**
 * What to DO with one picked photo (docs/feat/mobile-compose.md D5) — pure, so
 * every refusal and every conversion is testable without a simulator.
 *
 * The rule the whole module exists for: **the type comes from the BYTES**
 * (`sniffImageType`, `@tentacle/core`), never from the picker's `mimeType` or
 * the file's extension. An iPhone exports a HEIC named `.jpg` all the time, and
 * a `.png` that is really a JPEG is routine; the daemon re-verifies the ref it
 * receives, so a lying type would be caught only after the bytes had crossed
 * the wire.
 *
 * The steps are a CONVERSATION, not a decision table with loops: the adapter
 * asks `nextPhotoStep`, performs the one effect it names, and asks again with
 * the result. Each step may happen at most once (`converted`, `downscaled`), so
 * a photo that stays over the cap after its one downscale is refused rather
 * than shrunk forever (Owner Q3: one step, then refuse visibly).
 */
import {
  ATTACHMENT_NAME_MAX_CHARS,
  type ImageMimeType,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BYTES,
  formatBytes,
  sanitizeAttachmentName,
  sniffImageType,
} from "@tentacle/core";

/** Why a picked photo is not going out with this message. */
export type PhotoRefusal =
  /** Zero bytes: nothing was picked, or the copy came back empty. */
  | "empty"
  /** The message already holds `MAX_ATTACHMENTS_PER_MESSAGE`. */
  | "too-many"
  /** Over `MAX_IMAGE_BYTES` after the one allowed downscale. */
  | "too-large"
  /** Not an image (a video, a PDF, a truncated file), or still HEIC after converting. */
  | "not-an-image";

/** One photo as the pipeline currently sees it. */
export interface PhotoState {
  /** The CURRENT bytes — replaced by each conversion/shrink step. */
  readonly bytes: Uint8Array;
  /** The picker's file name. Display only; sanitised below, never trusted. */
  readonly name?: string;
  /** How many photos the message already holds (the 5-photo cap). */
  readonly taken: number;
  /** The HEIC → JPEG conversion already happened (once only, Owner Q3). */
  readonly converted: boolean;
  /** The one downscale-to-fit step already happened (once only, Owner Q3). */
  readonly downscaled: boolean;
  /**
   * The pick's intrinsic size, when the picker reports one (item 5). Absent is
   * the normal case for a fake and possible in the picker too: a photo with no
   * measured size is sent as it came (never a guessed aspect ratio).
   */
  readonly width?: number;
  readonly height?: number;
  /**
   * The one long-edge resize already happened (item 5). Separate from
   * `downscaled`, which is the over-`MAX_IMAGE_BYTES` shrink: they are two
   * different reasons to change the bytes, each allowed once.
   */
  readonly resized?: boolean;
  /** The person's "Send photos at original size" (item 5): no long-edge resize. */
  readonly sendOriginal?: boolean;
}

/** A photo that may be uploaded: its bytes decided the type, its name is safe. */
export interface ReadyPhoto {
  readonly mimeType: ImageMimeType;
  readonly size: number;
  readonly name?: string;
}

/**
 * The longest edge a sent photo keeps (item 5). Models downsample anyway
 * (Claude takes ~1568 px) and a local VL model turns pixels into tokens, so a
 * 4032×3024 / several-MB photo is slow prefill and a slow upload for nothing.
 * A JPEG at this edge is ≈300–600 KB.
 */
export const PHOTO_MAX_EDGE = 2048;

/** The JPEG quality of that resize (the plan's own figure). */
export const PHOTO_JPEG_QUALITY = 0.8;

/** The next thing the adapter must do, or the answer. */
export type PhotoStep =
  | { readonly kind: "convert-to-jpeg" }
  /** Shrink to fit `MAX_IMAGE_BYTES` (the legacy over-cap step). */
  | { readonly kind: "downscale" }
  /**
   * The long-edge resize (item 5): the EXACT target, so the adapter never
   * recomputes it and the aspect ratio is the pipeline's decision, not the
   * effect's.
   */
  | {
      readonly kind: "resize";
      readonly width: number;
      readonly height: number;
      readonly quality: number;
    }
  | { readonly kind: "ready"; readonly photo: ReadyPhoto }
  | { readonly kind: "refuse"; readonly reason: PhotoRefusal; readonly detail: string };

/**
 * The ONE dimension a resize should name, for a target the pure step chose.
 *
 * `ImageManipulator.resize` does NOT preserve the aspect ratio when it is given
 * both numbers — it fits the image into that box. So the effect must name the
 * LONG edge only and let the manipulator derive the other from the pixels it
 * actually holds (Review round 1, MEDIUM 3: a picker that reports
 * pre-EXIF-orientation dimensions would otherwise squash a portrait photo into a
 * landscape box). The pure step still computes both, because deciding which edge
 * is the long one IS the decision; `resizeAxis` says what to do about it.
 */
export function resizeAxis(target: {
  readonly width: number;
  readonly height: number;
}): { readonly width: number } | { readonly height: number } {
  return target.width >= target.height ? { width: target.width } : { height: target.height };
}

/** The long-edge resize's target, or null when the photo is already small enough. */
function resizeTarget(state: PhotoState): { width: number; height: number } | null {
  const { width, height } = state;
  if (width === undefined || height === undefined || width <= 0 || height <= 0) {
    return null;
  }
  const longEdge = Math.max(width, height);
  if (longEdge <= PHOTO_MAX_EDGE) {
    return null; // never upscale: a small photo stays exactly as it is
  }
  const scale = PHOTO_MAX_EDGE / longEdge;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function refuse(reason: PhotoRefusal, detail: string): PhotoStep {
  return { kind: "refuse", reason, detail };
}

/**
 * The next step for `state`. `convert-to-jpeg` / `downscale` are the ONLY two
 * effects, and each is returned at most once per photo, so the adapter's loop
 * always settles in at most three calls.
 */
export function nextPhotoStep(state: PhotoState): PhotoStep {
  if (state.taken >= MAX_ATTACHMENTS_PER_MESSAGE) {
    return refuse("too-many", `a message carries at most ${MAX_ATTACHMENTS_PER_MESSAGE} photos`);
  }
  const size = state.bytes.length;
  if (size === 0) {
    return refuse("empty", "the picked photo has no bytes");
  }
  const sniffed = sniffImageType(state.bytes);
  if (sniffed.kind === "heic") {
    // An iPhone's own format: never sent as HEIC (no provider accepts it, and
    // the wire's `IMAGE_MIME_TYPES` is the entry point's rule), so the adapter
    // re-encodes it — and this function sniffs the RESULT, not the picker's word.
    return state.converted
      ? refuse("not-an-image", `still ${sniffed.brand} after converting it to JPEG`)
      : { kind: "convert-to-jpeg" };
  }
  if (sniffed.kind === "not-image") {
    return refuse("not-an-image", "the bytes are not a PNG, JPEG, GIF or WebP image");
  }
  // Item 5's long-edge rule, BEFORE the byte cap: it is the cheaper, always-on
  // bound, and one resize then serves both reasons. A GIF is exempt for the same
  // reason the cap exempts it — re-encoding would drop its animation — and
  // "Send photos at original size" turns the rule off entirely (the person's
  // choice, never a silent override). Already resized once ⇒ never again.
  if (state.resized !== true && state.sendOriginal !== true && sniffed.mimeType !== "image/gif") {
    const target = resizeTarget(state);
    if (target !== null) {
      return {
        kind: "resize",
        width: target.width,
        height: target.height,
        quality: PHOTO_JPEG_QUALITY,
      };
    }
  }
  if (size > MAX_IMAGE_BYTES) {
    if (sniffed.mimeType === "image/gif") {
      // Re-encoding a GIF would drop its animation: refuse instead of "fixing" it.
      return refuse(
        "too-large",
        `a GIF of ${formatBytes(size)} is over the ${formatBytes(MAX_IMAGE_BYTES)} limit and is not re-encoded`,
      );
    }
    return state.downscaled
      ? refuse(
          "too-large",
          `${formatBytes(size)} is still over the ${formatBytes(MAX_IMAGE_BYTES)} limit after resizing`,
        )
      : { kind: "downscale" };
  }
  const name = state.name === undefined ? undefined : sanitizeAttachmentName(state.name);
  return {
    kind: "ready",
    photo: {
      mimeType: sniffed.mimeType,
      size,
      ...(name === undefined ? {} : { name: nameForType(name, sniffed.mimeType) }),
    },
  };
}

/**
 * The name a REF must carry for a picked photo, or `undefined`.
 *
 * Separate and exported because it is the failure this repo already shipped
 * once: a name with a C1 control character (NEL, CSI) passes a `\u0000-\u001f`
 * filter and then throws at `checkAttachmentRefs`, refusing the WHOLE message
 * instead of one image. `sanitizeAttachmentName` applies the wire's own rule
 * (`ATTACHMENT_NAME_RE`, imported, never copied) and the wire's 255-char cap.
 */
export function photoName(raw: string | null | undefined): string | undefined {
  return raw === null || raw === undefined ? undefined : sanitizeAttachmentName(raw);
}

/**
 * The name of one photo's sandbox COPY, unique per pick.
 *
 * The copy used to be `${Date.now()}-${name}`, written with `overwrite: true`, so
 * two picks landing in the same millisecond under the same name (two photos with
 * no name both become `photo.jpg`; two names can sanitise to one string) shared
 * ONE file: the first outbox item then sent the second photo's bytes — silently,
 * and a re-upload sent the wrong image. The `seq` part (a per-process counter,
 * the adapter's) makes that impossible, and the copy is created `overwrite:
 * false`, so a collision would fail loudly instead of swapping bytes.
 *
 * It wears the type's extension (`nameForType`) for the reason found on the
 * simulator: a copy of converted bytes labelled `.heic` contradicts itself.
 *
 * The WHOLE name is capped, not just the stem it inherits: a ref's name may be
 * 255 characters and the copy prefixes it with `<stamp>-<seq>-`, so an
 * inherited cap would still overflow the filesystem's own name limit and fail
 * the write. The name is ASCII by then (the `safe` filter above is the only thing
 * that reaches it), so a unit cap here is a byte cap too — and the EXTENSION
 * still gets its room, so a truncated copy still says what it is.
 */
export function photoCopyName(
  name: string | undefined,
  mimeType: ImageMimeType,
  pick: { readonly stamp: number; readonly seq: number },
): string {
  const safe =
    name === undefined || name === "" ? undefined : name.replace(/[^A-Za-z0-9._-]/g, "_");
  const named = nameForType(safe, mimeType) ?? `photo${EXTENSIONS[mimeType]}`;
  const prefix = `${pick.stamp}-${pick.seq}-`;
  const budget = ATTACHMENT_NAME_MAX_CHARS - prefix.length;
  const at = named.lastIndexOf(".");
  // No extension (a name like `photo` or `.hidden`): the whole string is the stem.
  if (at <= 0) {
    return `${prefix}${clipToUnits(named, budget)}`;
  }
  const extension = named.slice(at);
  return `${prefix}${clipToUnits(named.slice(0, at), budget - extension.length)}${extension}`;
}

/** The extension each accepted type wears in a ref's name. */
const EXTENSIONS: Record<ImageMimeType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/**
 * `name` with its extension agreeing with `mimeType` — where the pipeline
 * itself changed the format.
 *
 * Found on the simulator (Step 0, second probe): a HEIC converted to JPEG went
 * out as `{mimeType: "image/jpeg", name: "IMG_0111.heic"}`, so the transcript's
 * own `[image: IMG_0111.heic]` told the reader the opposite of what was sent.
 * The type still comes from the BYTES (this never decides a type — it only
 * stops the name from contradicting one); a name with no extension is left
 * alone, because a phone's own name may simply have none.
 */
export function nameForType(name: string | undefined, mimeType: ImageMimeType): string | undefined {
  if (name === undefined) {
    return undefined;
  }
  const at = name.lastIndexOf(".");
  if (at <= 0) {
    return name;
  }
  const wanted = EXTENSIONS[mimeType];
  const current = name.slice(at).toLowerCase();
  // `.jpeg` and `.jpg` are the same type: not a contradiction, leave it as the
  // person's device spelled it.
  if (current === wanted || (wanted === ".jpg" && current === ".jpeg")) {
    return name;
  }
  // The rename can be WIDER than the extension it replaces (`.png` → `.webp`),
  // and `sanitizeAttachmentName` has already spent the wire's whole 255-character
  // budget on the OLD name — so renaming alone can push a legal name past it, and
  // the wire then refuses the WHOLE message (`AttachmentRefSchema.name.max(255)`),
  // which is the very failure the name rule exists to prevent. The STEM gives
  // way, never the extension: the name must still say what the bytes are.
  return `${clipToUnits(name.slice(0, at), ATTACHMENT_NAME_MAX_CHARS - wanted.length)}${wanted}`;
}

/**
 * `text` cut to at most `max` UTF-16 units — the unit the wire's `.max(255)`
 * counts — never splitting a surrogate pair, by the same rule (and for the same
 * reason) as `sanitizeAttachmentName`'s own cap.
 */
function clipToUnits(text: string, max: number): string {
  let kept = "";
  for (const char of text) {
    if (kept.length + char.length > max) {
      break;
    }
    kept += char;
  }
  return kept;
}
