/**
 * `imageLimits` — the ONE truth for what a model can take
 * (docs/feat/attachments-prompt.md D4).
 *
 * Before this, the anthropic provider defaulted `images` to true and openai to
 * false inline, and nothing else could ask. A capability advertised from a
 * second copy of those defaults could disagree with what the provider does, so
 * both providers call this and the daemon's capability is derived from it.
 */
import { describe, expect, test } from "bun:test";
import { MAX_IMAGE_BYTES } from "@tentacle/protocol";
import {
  ANTHROPIC_MAX_IMAGE_BYTES,
  NO_IMAGES,
  OPENAI_MAX_IMAGE_BYTES,
  imageLimits,
} from "../src/index.ts";

describe("imageLimits defaults", () => {
  test("anthropic defaults to vision on, at its documented cap", () => {
    expect(imageLimits("anthropic", {})).toEqual({
      vision: true,
      maxBytes: ANTHROPIC_MAX_IMAGE_BYTES,
    });
  });

  test("openai-compatible defaults to vision OFF, with its conservative cap", () => {
    expect(imageLimits("openai", {})).toEqual({
      vision: false,
      maxBytes: OPENAI_MAX_IMAGE_BYTES,
    });
  });
});

describe("imageLimits overrides", () => {
  test("model.images turns vision off (anthropic) and on (openai)", () => {
    expect(imageLimits("anthropic", { images: false }).vision).toBe(false);
    expect(imageLimits("openai", { images: true }).vision).toBe(true);
  });

  test("model.maxImageBytes sets the cap, never above the entry point's bound", () => {
    expect(imageLimits("anthropic", { maxImageBytes: 1024 }).maxBytes).toBe(1024);
    expect(imageLimits("openai", { maxImageBytes: 5 * 1024 * 1024 }).maxBytes).toBe(
      OPENAI_MAX_IMAGE_BYTES,
    );
    // Above MAX_IMAGE_BYTES (15 MiB) the entry point's own bound wins.
    expect(imageLimits("openai", { maxImageBytes: 99 * 1024 * 1024 }).maxBytes).toBe(
      MAX_IMAGE_BYTES,
    );
  });

  test("a non-vision model still reports its cap (the caller ignores it)", () => {
    expect(imageLimits("openai", { maxImageBytes: 2048 })).toEqual({
      vision: false,
      maxBytes: 2048,
    });
  });
});

describe("the constant the providers already used", () => {
  test("NO_IMAGES stays the no-bytes default", () => {
    expect(NO_IMAGES.vision).toBe(true);
    expect(NO_IMAGES.maxImageBytes).toBe(MAX_IMAGE_BYTES);
  });
});
