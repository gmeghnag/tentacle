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

/**
 * Whose model — and whose config — a "configured without images" reason is
 * about. A fact only the CALLER holds: `laptop` is the local worker and a
 * `--model-proxy` pod (this laptop runs the model, so the key and the command
 * are here); `daemon` is a daemon that runs its OWN model from its OWN config (a
 * `serve` host, a pod daemon started without `--model-proxy`), where running
 * `tentacle config set` on the laptop would change nothing.
 */
export type ImageModelScope = "laptop" | "daemon";

/**
 * The name a daemon reports for its model, made safe for a rendered line.
 *
 * Stripped of control characters (a pod-supplied `agentInfo.model` reaches a
 * terminal — AGENTS §7, a pod is not trusted) and cut at `max` — the SAME unit
 * `MAX_REASON_CHARS` counts (string length), but never mid-character: the cut
 * walks CODE POINTS, so an emoji or other astral character is either whole or
 * absent, never a lone surrogate a terminal cannot draw.
 */
function safeModel(
  raw: string | undefined,
  max: number = MAX_REASON_MODEL_CHARS,
): string | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const clean = raw
    // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim();
  if (clean === "") {
    return undefined;
  }
  const room = Math.max(1, max);
  if (clean.length <= room) {
    return clean;
  }
  // Whole code points only, and one unit kept for the ellipsis.
  let kept = "";
  for (const point of clean) {
    if (kept.length + point.length > room - 1) {
      break;
    }
    kept += point;
  }
  const short = kept === "" ? "…" : `${kept}…`;
  return short.trim() === "" ? undefined : short;
}

/**
 * Cause (a): this daemon is current, and a model's config has images off.
 * Names the model and the key, with the command that flips it — the fact the
 * old sentence hid behind "update it" — and says WHOSE config it is, because
 * the key lives wherever the model runs (fix round 1, finding 1).
 */
export function imagesOffReason(
  model: string | undefined,
  scope: ImageModelScope = "daemon",
): string {
  const [unnamed, tail] =
    scope === "laptop"
      ? [
          "this model",
          "is configured without images — set model.images true in your config if this model takes images (tentacle config set model.images true)",
        ]
      : [
          "the daemon's model",
          "is configured without images — set model.images true in the daemon's config if that model takes images (tentacle config set model.images true, on the daemon's host)",
        ];
  // The model name is what varies, and the SENTENCE is what a notice row holds:
  // give the name whatever `MAX_REASON_CHARS` leaves (never more than
  // `MAX_REASON_MODEL_CHARS`), shortened with an ellipsis rather than letting a
  // row wrap.
  const room = Math.max(1, Math.min(MAX_REASON_MODEL_CHARS, MAX_REASON_CHARS - tail.length - 2));
  const name = safeModel(model, room);
  return `${name === undefined ? unnamed : name} ${tail}`;
}

/** The facts about the daemon that decide WHICH cause applies (all display-only). */
export interface DaemonImageFacts {
  /** `initialize.protocolVersion` of the daemon we talk to; absent = unknown. */
  readonly protocol?: number;
  /**
   * The model the DAEMON reports for itself (`agentInfo.model`). Never used to
   * name another machine's model as ours: a pod-supplied name is not evidence
   * of what the laptop runs (AGENTS §7, a pod is not trusted).
   */
  readonly daemonModel?: string;
  /** THIS laptop's model id (`config.model`), when the caller knows it. */
  readonly laptopModel?: string;
  /**
   * Whose config an ABSENT capability is about (fix round 1, finding 1).
   * Default `daemon`: never tell a user to run a command on a machine the
   * evidence does not point at.
   */
  readonly scope?: ImageModelScope;
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
    // Whose config is off: the caller's `scope` says, and its own machine's
    // model names it. Naming the LAPTOP's model for a daemon that runs its own
    // is the confident, wrong advice this round removes.
    const onLaptop = daemon.scope === "laptop";
    return {
      kind: "off",
      reason: imagesOffReason(
        onLaptop ? daemon.laptopModel : daemon.daemonModel,
        onLaptop ? "laptop" : "daemon",
      ),
    };
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
      // The SAME cause as (a), on the laptop's side: a config, not a build —
      // and always the LAPTOP's (a `client`-mode daemon tunnels this laptop's
      // model, so `imageLimits()` here is the gate that failed). A name the
      // daemon reports for itself is not ours, so it is never used here.
      return { kind: "off", reason: imagesOffReason(daemon.laptopModel, "laptop") };
    }
    return { kind: "laptop", maxBytes: clamp(local.maxBytes) };
  }
  return { kind: "off", reason: `unknown image input ${capability.input} — update tentacle` };
}
