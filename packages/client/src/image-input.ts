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
): ImageInput {
  if (capability === undefined) {
    return {
      kind: "off",
      reason:
        "this daemon does not take images (its model has no vision, or it predates images — update it)",
    };
  }
  if (capability.input === "upload") {
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
      return { kind: "off", reason: "this laptop's model does not take images (model.images)" };
    }
    return { kind: "laptop", maxBytes: clamp(local.maxBytes) };
  }
  return { kind: "off", reason: `unknown image input ${capability.input} — update tentacle` };
}
