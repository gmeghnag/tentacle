/**
 * `imageInput` (docs/feat/attachments-prompt.md D5, T5): one pure table that
 * turns a daemon's advertised capability plus what THIS laptop can do into one
 * of three decisions. It is the entry point 3b calls, so the rule lives here,
 * testable without a socket — a component only renders the answer.
 */
import { describe, expect, test } from "bun:test";
import { MAX_IMAGE_BYTES, PROTOCOL_VERSION } from "@tentacle/protocol";
import {
  IMAGES_PROTOCOL_VERSION,
  type ImageInput,
  MAX_REASON_CHARS,
  OLD_DAEMON_IMAGES,
  imageInput,
} from "../src/image-input.ts";
import { ATTACHMENTS_OLD_DAEMON } from "../src/remote-client.ts";

const servesModel = { servesModel: true };
/** The current daemon: the protocol this build speaks (images arrived at 23). */
const CURRENT = PROTOCOL_VERSION;
/** A daemon older than images: its `initialize` never reached a build with them. */
const BEFORE_IMAGES = IMAGES_PROTOCOL_VERSION - 1;

const reasonOf = (got: ImageInput): string => {
  expect(got.kind).toBe("off");
  return got.kind === "off" ? got.reason : "";
};

/**
 * Why images are off (docs/feat/images-off-reason.md): the absent capability
 * used to claim ONE thing — "no vision, or it predates images — update it" —
 * so a current daemon on a model with `model.images` unset was told to update
 * software that was already up to date. Two causes, two sentences, decided from
 * facts the client holds: the daemon's protocol (equality is enforced at
 * `initialize`, so a handshaken daemon at 23+ HAS the capability) and its
 * reported model.
 */
describe("no capability: WHY (docs/feat/images-off-reason.md)", () => {
  test("T1 a CURRENT daemon: the model's config is off — name the model and the key", () => {
    const reason = reasonOf(
      imageInput(undefined, { servesModel: false }, { protocol: CURRENT, daemonModel: "llama3.2" }),
    );
    expect(reason).toContain("llama3.2");
    expect(reason).toContain("model.images");
    expect(reason).toContain("tentacle config set model.images true");
    // The whole bug: a daemon of our own protocol is NOT out of date.
    expect(reason).not.toContain("predates");
    expect(reason).not.toContain("update");
  });

  test("T2 a daemon that PREDATES images: say update it, and nothing about config", () => {
    const reason = reasonOf(
      imageInput(undefined, { servesModel: false }, { protocol: BEFORE_IMAGES }),
    );
    expect(reason).toContain("predates images");
    expect(reason).toContain("update");
    expect(reason).not.toContain("model.images");
  });

  test("T3 no handshake yet (protocol unknown): never claim the daemon is old", () => {
    const reason = reasonOf(imageInput(undefined, { servesModel: false }, {}));
    expect(reason).toContain("model.images");
    expect(reason).not.toContain("update");
  });

  test("T4 the daemon reports no model: still name the key and the place, invent no name", () => {
    const reason = reasonOf(imageInput(undefined, { servesModel: false }, { protocol: CURRENT }));
    expect(reason).toContain("model.images");
    expect(reason).toContain("the daemon's model");
    expect(reason).toContain("the daemon's config");
    expect(reason).not.toContain("predates");
  });

  test("T4b a LAPTOP-scoped daemon reporting nothing says 'this model', in YOUR config", () => {
    const reason = reasonOf(
      imageInput(undefined, { servesModel: false }, { protocol: CURRENT, scope: "laptop" }),
    );
    expect(reason).toContain("this model");
    expect(reason).toContain("your config");
    expect(reason).not.toContain("the daemon's");
  });

  test("T5 a hostile/over-long model name is sanitized and bounded before a line renders it", () => {
    const reason = reasonOf(
      imageInput(
        undefined,
        { servesModel: false },
        { protocol: CURRENT, daemonModel: `ev\u001b[31mil\u0007\n${"x".repeat(500)}` },
      ),
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
    expect(reason).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(reason).not.toContain("\n");
    expect(reason.split("\n")).toHaveLength(1);
    // The sentence itself is what a notice row holds, not just the name.
    expect(reason.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
    // One rendered line, and the advice survives the shortening.
    expect(reason).toContain("model.images");
    expect(reason).toContain("tentacle config set model.images true");
    expect(reason.startsWith("ev ")).toBe(true);
  });

  test("T5b an over-long plain name is shortened, never wrapped", () => {
    const reason = reasonOf(
      imageInput(
        undefined,
        { servesModel: false },
        { protocol: CURRENT, daemonModel: "m".repeat(400) },
      ),
    );
    expect(reason.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
    expect(reason).toContain("model.images");
    expect(reason).not.toContain("m".repeat(MAX_REASON_CHARS));
  });

  test("T5c a name cut for room ends on a code point, never a split surrogate", () => {
    const reason = reasonOf(
      imageInput(
        undefined,
        { servesModel: false },
        { protocol: CURRENT, daemonModel: "\u{1F600}".repeat(200) },
      ),
    );
    expect(reason.length).toBeLessThanOrEqual(MAX_REASON_CHARS);
    // A lone surrogate would make this false (it cannot be encoded as UTF-8).
    expect(Buffer.from(reason, "utf8").toString("utf8")).toBe(reason);
    expect(reason).toContain("…");
  });

  test("T6 one source for the update advice: the attachment/put refusal shares it", () => {
    expect(ATTACHMENTS_OLD_DAEMON).toBe(OLD_DAEMON_IMAGES);
  });

  // Fix round 1, finding 1: the key and the command live wherever the model
  // does, so a daemon-scoped reason never tells a user to change THIS laptop.
  test("T7 a daemon-scoped reason never points at this laptop's config", () => {
    const reason = reasonOf(
      imageInput(
        undefined,
        { servesModel: false },
        { protocol: CURRENT, daemonModel: "pod-model", scope: "daemon" },
      ),
    );
    expect(reason).toContain("pod-model");
    expect(reason).toContain("the daemon's config");
    expect(reason).not.toContain("your config");
    expect(reason).not.toContain("this model");
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
