/**
 * `daemonImagePolicy` (docs/feat/attachments-prompt.md D4, T10): the ONE pure
 * place that decides what a daemon does with image prompts.
 *
 * The rule it encodes is the feature's: **whoever runs the provider holds the
 * bytes.** With `--model-proxy` the LAPTOP runs it, so the pod declares
 * `client` and never holds a byte (upload Owner Q2, AGENTS §7). Otherwise the
 * daemon runs it, so it declares `store` with the cap its own model can take —
 * and refuses images outright when that model has no vision, rather than
 * advertising a capability every prompt would then be refused for.
 */
import { describe, expect, test } from "bun:test";
import { ANTHROPIC_MAX_IMAGE_BYTES, OPENAI_MAX_IMAGE_BYTES } from "@tentacle/providers";
import { daemonImagePolicy } from "../src/image-policy.ts";

const config = (over: Record<string, unknown> = {}) =>
  ({ provider: "anthropic", model: "m", ...over }) as never;

describe("a pod with --model-proxy", () => {
  test("declares `client`, whatever its own model can do", () => {
    expect(daemonImagePolicy(config({ images: false }), { modelProxy: true })).toEqual({
      source: "client",
    });
  });
});

describe("a daemon that runs the model itself", () => {
  test("anthropic's default is vision on, at its documented cap", () => {
    expect(daemonImagePolicy(config(), {})).toEqual({
      source: "store",
      maxBytes: ANTHROPIC_MAX_IMAGE_BYTES,
    });
  });

  test("an OpenAI-compatible endpoint's default is OFF (no capability at all)", () => {
    expect(daemonImagePolicy(config({ provider: "openai" }), {})).toBeUndefined();
  });

  test("model.images: true opts an openai endpoint in", () => {
    expect(daemonImagePolicy(config({ provider: "openai", images: true }), {})).toEqual({
      source: "store",
      maxBytes: OPENAI_MAX_IMAGE_BYTES,
    });
  });

  test("model.images: false turns anthropic off", () => {
    expect(daemonImagePolicy(config({ images: false }), {})).toBeUndefined();
  });

  test("model.maxImageBytes is the advertised cap", () => {
    expect(daemonImagePolicy(config({ maxImageBytes: 1024 }), {})).toEqual({
      source: "store",
      maxBytes: 1024,
    });
  });

  test("a cap above MAX_IMAGE_BYTES is clamped: the entry point's bound wins", () => {
    expect(daemonImagePolicy(config({ maxImageBytes: 99 * 1024 * 1024 }), {})).toEqual({
      source: "store",
      maxBytes: 15 * 1024 * 1024,
    });
  });
});
