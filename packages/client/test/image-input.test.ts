/**
 * `imageInput` (docs/feat/attachments-prompt.md D5, T5): one pure table that
 * turns a daemon's advertised capability plus what THIS laptop can do into one
 * of three decisions. It is the entry point 3b calls, so the rule lives here,
 * testable without a socket — a component only renders the answer.
 */
import { describe, expect, test } from "bun:test";
import { MAX_IMAGE_BYTES } from "@tentacle/protocol";
import { imageInput } from "../src/image-input.ts";

const servesModel = { servesModel: true };

describe("no capability", () => {
  test("a daemon that advertises nothing is off, and says to update it", () => {
    const got = imageInput(undefined, { servesModel: false });
    expect(got.kind).toBe("off");
    if (got.kind === "off") expect(got.reason).toContain("does not take images");
  });
});

describe("input: upload (the daemon runs the model)", () => {
  test("the advertised cap is the limit", () => {
    expect(imageInput({ input: "upload", maxBytes: 3932160 }, { servesModel: false })).toEqual({
      kind: "upload",
      maxBytes: 3932160,
    });
  });

  test("an absent cap falls back to MAX_IMAGE_BYTES", () => {
    expect(imageInput({ input: "upload" }, { servesModel: false })).toEqual({
      kind: "upload",
      maxBytes: MAX_IMAGE_BYTES,
    });
  });

  test("an advertised cap above MAX_IMAGE_BYTES is clamped (never widen the entry point)", () => {
    expect(
      imageInput({ input: "upload", maxBytes: 99 * 1024 * 1024 }, { servesModel: false }),
    ).toEqual({ kind: "upload", maxBytes: MAX_IMAGE_BYTES });
  });

  // Review round 1, finding 1 (HIGH): a pod's OWN claim must never make this
  // laptop put image bytes inside it (AGENTS §7 "a pod is not trusted"). The
  // only laptop that serves a model is a `--model-proxy` pod's, i.e. a `client`
  // daemon; a daemon that says `upload` to such a laptop is lying (a replaced
  // binary, or a same-uid process on its socket), so the answer is off.
  test("a laptop that serves the model NEVER uploads into the daemon that asks", () => {
    for (const local of [servesModel, { servesModel: true, vision: true, maxBytes: 512 }]) {
      const got = imageInput({ input: "upload", maxBytes: 100 }, local);
      expect({ local, kind: got.kind }).toEqual({ local, kind: "off" });
      if (got.kind === "off") expect(got.reason).toContain("serving its model");
    }
  });
});

describe("input: client (this laptop runs the model)", () => {
  test("a laptop that serves no model is off", () => {
    const got = imageInput({ input: "client" }, { servesModel: false });
    expect(got.kind).toBe("off");
    if (got.kind === "off") expect(got.reason).toContain("serve the model");
  });

  test("a laptop with no vision is off", () => {
    const got = imageInput({ input: "client" }, { ...servesModel, vision: false, maxBytes: 10 });
    expect(got.kind).toBe("off");
    if (got.kind === "off") expect(got.reason).toContain("model.images");
  });

  test("vision on: the bytes stay here, under the laptop's own cap", () => {
    expect(
      imageInput({ input: "client" }, { ...servesModel, vision: true, maxBytes: 512 }),
    ).toEqual({
      kind: "laptop",
      maxBytes: 512,
    });
  });

  test("vision on with no cap known falls back to MAX_IMAGE_BYTES", () => {
    expect(imageInput({ input: "client" }, { ...servesModel, vision: true })).toEqual({
      kind: "laptop",
      maxBytes: MAX_IMAGE_BYTES,
    });
  });
});

describe("forward compatibility", () => {
  test("an unknown input is off, never guessed", () => {
    for (const input of ["some-future-mode", "UPLOAD", ""]) {
      const got = imageInput({ input }, servesModel);
      expect({ input, kind: got.kind }).toEqual({ input, kind: "off" });
      if (got.kind === "off") expect(got.reason).toContain(input === "" ? "unknown" : input);
    }
  });
});
