/**
 * What a daemon does with image prompts (docs/feat/attachments-prompt.md D4).
 *
 * The feature's rule, in one pure function: **whoever runs the provider holds
 * the bytes.** With a pod's `--model-proxy` the LAPTOP runs the model, so the
 * pod declares `client`, holds nothing and sends only refs (upload Owner Q2,
 * AGENTS §7 "a pod is not trusted"). Otherwise the daemon runs it, so it
 * declares `store` with the cap its own model can take — or nothing at all when
 * that model has no vision, which is what makes `initialize` advertise no image
 * input instead of a capability every prompt would then be refused for.
 *
 * Pure, and the single caller of `imageLimits()` on this side, so the advertised
 * capability can never disagree with what the provider actually does.
 */
import type { DocumentPolicy, ImagePolicy } from "@tentacle/daemon";
import { MAX_IMAGE_BYTES } from "@tentacle/protocol";
import { imageLimits } from "@tentacle/providers";
import { extractPdf } from "@tentacle/tools";

/** The config keys this decision reads (a resolved `TentacleConfig` has them). */
export interface ImagePolicyConfig {
  readonly provider: "anthropic" | "openai";
  /** `model.images`: unset keeps the provider's own default. */
  readonly images?: boolean;
  /** `model.maxImageBytes`: this model's cap, and the one it advertises. */
  readonly maxImageBytes?: number;
}

/**
 * The daemon's image policy, or `undefined` when it takes none.
 *
 * `modelProxy` is the pod's `--model-proxy`: the laptop is the model link, so
 * the decision is `client` and the pod's own model config is irrelevant.
 */
export function daemonImagePolicy(
  config: ImagePolicyConfig,
  opts: { readonly modelProxy?: boolean } = {},
): ImagePolicy | undefined {
  if (opts.modelProxy === true) {
    return { source: "client" };
  }
  const limits = imageLimits(config.provider, config);
  return limits.vision ? { source: "store", maxBytes: limits.maxBytes } : undefined;
}

/**
 * What a daemon does with attached documents (docs/feat/pdf-read.md D4): a
 * daemon on the user's own machine (in-process worker, `serve`) holds uploaded
 * bytes and extracts them; a POD takes text only — the laptop extracts, and PDF
 * bytes never enter a pod (AGENTS §7), with or without `--model-proxy`.
 * Unlike images, it does not depend on the model: a `<file>` block is text.
 */
export function daemonDocumentPolicy(where: "host" | "pod"): DocumentPolicy {
  return where === "pod"
    ? { source: "client" }
    : { source: "store", maxBytes: MAX_IMAGE_BYTES, extract: extractPdf };
}
