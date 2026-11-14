/**
 * Where an image's bytes live for this session (docs/feat/attachments-prompt.md D5).
 *
 * The rule the whole feature turns on: **whoever runs the provider holds the
 * bytes.** A daemon that runs the model can only use bytes it holds, so the
 * client uploads them (`attachment/put`) and names the ref; a LAPTOP that runs
 * the model for a pod keeps the bytes and never sends them (upload Owner Q2,
 * AGENTS §7 "a pod is not trusted"). The daemon says which case applies —
 * `initialize.agentCapabilities.images` — and this table decides, once, for 3b.
 *
 * Pure: a caller passes the capability and what this laptop can do; a component
 * only renders the answer. An unknown `input` is OFF, never guessed — a newer
 * daemon's mode must not make this build upload bytes somewhere unexpected.
 */
import { MAX_IMAGE_BYTES } from "@tentacle/protocol";

/** The daemon's advertised capability (`agentCapabilities.images`); absent = none. */
export interface ImagesCapability {
  readonly input: string;
  readonly maxBytes?: number;
}

/**
 * The protocol that introduced image input (docs/feat/attachments-core.md,
 * `PROTOCOL_VERSION` 23). A daemon at or past it that advertises no
 * `images` capability is CURRENT — it simply takes no images on this model.
 */
export const IMAGES_PROTOCOL_VERSION = 23;

/**
 * A daemon that really predates images (docs/feat/images-off-reason.md): the
 * ONE update advice, shared with `attachment/put`'s `MethodNotFound` refusal so
 * the two surfaces cannot word "update the daemon" differently.
 */
export const OLD_DAEMON_IMAGES = "this daemon predates images — update it";

/** Longest model name this reason repeats (a display line, never a full id). */
export const MAX_REASON_MODEL_CHARS = 80;
/** Bound on a whole `reason` sentence: a notice row, not a paragraph. */
export const MAX_REASON_CHARS = 220;

/** The name a daemon reports for its model, made safe for a rendered line. */
function safeModel(
  raw: string | undefined,
  max: number = MAX_REASON_MODEL_CHARS,
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  // A pod-supplied `agentInfo.model` reaches a terminal (AGENTS §7: a pod is
  // not trusted), so control characters go and the line is bounded.
  const clean = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim()
    .slice(0, Math.max(1, max));
  return clean === "" ? undefined : clean;
}

/**
 * Cause (a): this daemon is current, and its model's config has images off.
 * Names the model and the key, with the command that flips it — the fact the
 * old sentence hid behind "update it".
 */
export function imagesOffReason(model: string | undefined): string {
  const tail =
    "is configured without images — set model.images true in your config if this model takes images (tentacle config set model.images true)";
  // The model name is what varies, and the SENTENCE is what a notice row holds:
  // give the name whatever `MAX_REASON_CHARS` leaves, shortened with an ellipsis
  // rather than letting a row wrap.
  const room = Math.max(1, MAX_REASON_CHARS - tail.length - 2);
  const name = safeModel(model, room);
  return `${name === undefined ? "this model" : name} ${tail}`;
}

/** The facts about the daemon that decide WHICH cause applies (all display-only). */
export interface DaemonImageFacts {
  /** `initialize.protocolVersion` of the daemon we talk to; absent = unknown. */
  readonly protocol?: number;
  /** The model that runs the turns: `agentInfo.model`, else this laptop's own. */
  readonly model?: string;
}

/** What THIS client can do: whether it serves the model, and its vision config. */
export interface LocalImageConfig {
  /** True when this client holds the model provider (a pod's laptop). */
  readonly servesModel: boolean;
  /** `model.images` as resolved by `imageLimits()`; unset = the provider default. */
  readonly vision?: boolean;
  /** The laptop provider's per-image cap (also from `imageLimits()`). */
  readonly maxBytes?: number;
}

/**
 * What a client may do with an image:
 * - `upload`: send the bytes by `attachment/put`, then name the ref (the daemon runs the model);
 * - `laptop`: keep the bytes here and name the ref only (this laptop runs the model);
 * - `off`: refuse, with a sentence a user reads (nothing is uploaded, nothing is sent).
 */
export type ImageInput =
  | { readonly kind: "upload"; readonly maxBytes: number }
  | { readonly kind: "laptop"; readonly maxBytes: number }
  | { readonly kind: "off"; readonly reason: string };

const clamp = (max: number | undefined): number =>
  max === undefined ? MAX_IMAGE_BYTES : Math.min(max, MAX_IMAGE_BYTES);

export function imageInput(
  capability: ImagesCapability | undefined,
  local: LocalImageConfig,
  daemon: DaemonImageFacts = {},
): ImageInput {
  if (capability === undefined) {
    // Two different causes, told apart by a fact the client holds (docs/feat/
    // images-off-reason.md): `initialize` enforces protocol EQUALITY, so a
    // daemon that handshook at IMAGES_PROTOCOL_VERSION or later has the
    // capability and its absence is about its MODEL CONFIG — telling that user
    // to "update" current software was the bug. Only a daemon whose own
    // protocol predates images (or one that never answered) is old, and an
    // unknown protocol is NOT evidence of age.
    if (daemon.protocol !== undefined && daemon.protocol < IMAGES_PROTOCOL_VERSION) {
      return { kind: "off", reason: OLD_DAEMON_IMAGES };
    }
    return { kind: "off", reason: imagesOffReason(daemon.model) };
  }
  if (capability.input === "upload") {
    // A client that serves a model is a `--model-proxy` pod's laptop, so the
    // daemon it talks to is a `client` daemon. An `upload` from it means the
    // daemon is lying (a replaced binary, or a same-uid process on its socket),
    // and the claim is its OWN: believing it would put image bytes inside a
    // pod that asked for them (AGENTS §7 "a pod is not trusted"; upload Owner
    // Q2 "no bytes in a pod"). The gate is on the laptop, so this is OFF — never
    // an upload, never a guess.
    if (local.servesModel) {
      return {
        kind: "off",
        reason:
          "this daemon asks for image uploads while this client is serving its model — the daemon's claim is not trustworthy, so nothing is uploaded",
      };
    }
    return { kind: "upload", maxBytes: clamp(capability.maxBytes) };
  }
  if (capability.input === "client") {
    if (!local.servesModel) {
      return {
        kind: "off",
        reason: "the daemon expects this client to serve the model, and it does not",
      };
    }
    if (local.vision !== true) {
      // The SAME cause as (a), on the laptop's side: a config, not a build.
      return { kind: "off", reason: imagesOffReason(daemon.model) };
    }
    return { kind: "laptop", maxBytes: clamp(local.maxBytes) };
  }
  return { kind: "off", reason: `unknown image input ${capability.input} — update tentacle` };
}
