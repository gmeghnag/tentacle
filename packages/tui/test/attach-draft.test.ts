/**
 * The input's image draft (docs/feat/attachments-tui.md D6, T1): every decision
 * the App only executes. Pure, so the whole failure table of the task doc is
 * pinned here without a terminal.
 */
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { AttachmentRef } from "@tentacle/core";
import {
  type AttachDraft,
  type AttachMode,
  EMPTY_DRAFT,
  NO_IMAGE_SEAM,
  attachErrorText,
  attachRowRows,
  attachRowView,
  chipLabel,
  draftRefs,
  imageRowText,
  looksLikeCommand,
  removeLastChip,
  routeDecision,
  submitPlan,
  uploadDone,
  uploadProgress,
  withChips,
} from "../src/attach-draft.ts";
import type { AttachedImage } from "../src/attach-files.ts";

const UPLOAD: AttachMode = { kind: "upload", maxBytes: 4 * 1024 * 1024 };
const OFF: AttachMode = { kind: "off", reason: "this daemon does not take images" };
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

const chipOf = (name: string, size = 2048): AttachedImage => {
  const ref: AttachmentRef = { id: sha(name), mimeType: "image/png", size, name };
  return { path: `/tmp/${name}`, ref, bytes: new Uint8Array([1, 2, 3]) };
};
const anonymous = (mimeType = "image/png", size = 10): AttachedImage => ({
  path: "/tmp/x",
  ref: { id: sha(mimeType), mimeType, size },
  bytes: new Uint8Array([1]),
});
const draftWith = (...chips: AttachedImage[]): AttachDraft => ({ chips, upload: null });

describe("routeDecision", () => {
  test("plain text is inserted, nothing else changes", () => {
    const r = routeDecision(EMPTY_DRAFT, { kind: "text" }, UPLOAD, "hello there");
    expect(r).toEqual({ draft: EMPTY_DRAFT, insert: "hello there", notices: [] });
  });

  test("an empty paste inserts nothing", () => {
    const r = routeDecision(EMPTY_DRAFT, { kind: "text" }, UPLOAD);
    expect(r.insert).toBeUndefined();
    expect(r.notices).toEqual([]);
  });

  test("images become chips and their refusals become notices, nothing inserted", () => {
    const a = chipOf("a.png");
    const r = routeDecision(
      EMPTY_DRAFT,
      { kind: "attachments", images: [a], refusals: [{ reason: "heic", path: "/tmp/i.heic" }] },
      UPLOAD,
      "/tmp/a.png /tmp/i.heic",
    );
    expect(r.insert).toBeUndefined();
    expect(r.draft.chips).toEqual([a]);
    expect(r.notices).toHaveLength(1);
    expect(r.notices[0]).toContain("HEIC");
  });

  test("a refused decision shows every refusal and inserts nothing", () => {
    const r = routeDecision(
      EMPTY_DRAFT,
      { kind: "refused", refusals: [{ reason: "not-found", path: "/nope.png" }] },
      UPLOAD,
      "/attach /nope.png",
    );
    expect(r.insert).toBeUndefined();
    expect(r.notices).toEqual(["cannot attach /nope.png: no such file"]);
    expect(r.draft).toBe(EMPTY_DRAFT);
  });

  test("images OFF: ONE reason notice, no chip, and the path never becomes text (decision 10)", () => {
    const a = chipOf("a.png");
    const r = routeDecision(
      EMPTY_DRAFT,
      { kind: "attachments", images: [a], refusals: [] },
      OFF,
      "/tmp/a.png",
    );
    expect(r.insert).toBeUndefined();
    expect(r.draft.chips).toEqual([]);
    expect(r.notices).toEqual(["_images are off: this daemon does not take images_"]);
  });

  test("images OFF still explains a refused file", () => {
    const r = routeDecision(
      EMPTY_DRAFT,
      { kind: "refused", refusals: [{ reason: "too-large", path: "/huge.png", size: 20_000_000 }] },
      OFF,
    );
    expect(r.notices).toHaveLength(2);
    expect(r.notices[0]).toContain("images are off");
    expect(r.notices[1]).toContain("huge.png");
  });

  test("a second paste appends to the chips it already holds", () => {
    const a = chipOf("a.png");
    const b = chipOf("b.png");
    const r = routeDecision(
      draftWith(a),
      { kind: "attachments", images: [b], refusals: [] },
      UPLOAD,
    );
    expect(r.draft.chips).toEqual([a, b]);
  });
});

describe("withChips", () => {
  test("the per-message cap holds for the whole message, and the extra is counted", () => {
    const six = Array.from({ length: 6 }, (_, i) => chipOf(`${i}.png`));
    const { draft, overCap } = withChips(EMPTY_DRAFT, six);
    expect(draft.chips).toHaveLength(5);
    expect(overCap).toBe(1);
  });

  test("with no room at all nothing is appended and everything is counted", () => {
    const six = Array.from({ length: 5 }, (_, i) => chipOf(`${i}.png`));
    const { draft, overCap } = withChips(draftWith(...six), [chipOf("six.png")]);
    expect(draft.chips).toHaveLength(5);
    expect(overCap).toBe(1);
  });
});

describe("removeLastChip", () => {
  test("removes one, and an empty draft is unchanged", () => {
    const a = chipOf("a.png");
    const b = chipOf("b.png");
    expect(removeLastChip(draftWith(a, b)).chips).toEqual([a]);
    expect(removeLastChip(EMPTY_DRAFT)).toBe(EMPTY_DRAFT);
  });

  test("it drops the last chip, not the first", () => {
    const a = chipOf("a.png");
    const b = chipOf("b.png");
    expect(removeLastChip(draftWith(a, b)).chips[0]).toBe(a);
  });
});

describe("submitPlan", () => {
  const base = {
    draft: EMPTY_DRAFT,
    running: false,
    compacting: false,
    dockOpen: false,
    mode: UPLOAD,
    onlyPaths: false,
  };

  test("no chips, not only paths: today's path", () => {
    expect(submitPlan({ ...base, text: "what?" })).toEqual({ kind: "text" });
  });

  test("an unbracketed drop (only paths) converts and sends nothing (decision 5)", () => {
    expect(submitPlan({ ...base, text: "/tmp/a.png", onlyPaths: true })).toEqual({
      kind: "convert",
    });
  });

  test("chips + text while idle: send both", () => {
    const a = chipOf("a.png");
    expect(submitPlan({ ...base, text: "what?", draft: draftWith(a) })).toEqual({
      kind: "send",
      text: "what?",
      images: [a],
    });
  });

  test("chips with empty text: an image-only prompt", () => {
    const a = chipOf("a.png");
    const plan = submitPlan({ ...base, text: "", draft: draftWith(a) });
    expect(plan).toMatchObject({ kind: "send", text: "" });
  });

  test("chips while a turn runs: refuse, kept (decision 7) — never a silent enqueue", () => {
    const plan = submitPlan({
      ...base,
      text: "what?",
      draft: draftWith(chipOf("a.png")),
      running: true,
    });
    expect(plan.kind).toBe("refuse");
    if (plan.kind === "refuse") expect(plan.notice).toContain("can't send an image");
  });

  test("chips during a /compact, or with a child open: refuse too", () => {
    const draft = draftWith(chipOf("a.png"));
    expect(submitPlan({ ...base, text: "x", draft, compacting: true }).kind).toBe("refuse");
    expect(submitPlan({ ...base, text: "x", draft, dockOpen: true }).kind).toBe("refuse");
  });

  test("chips with images now OFF: refuse with the reason", () => {
    const plan = submitPlan({
      ...base,
      text: "x",
      draft: draftWith(chipOf("a.png")),
      mode: OFF,
    });
    expect(plan).toMatchObject({ kind: "refuse" });
    if (plan.kind === "refuse") expect(plan.notice).toContain("does not take images");
  });

  test("chips beat the only-paths rule: chips exist, so it sends (never a re-convert)", () => {
    const a = chipOf("a.png");
    expect(
      submitPlan({ ...base, text: "/tmp/a.png", draft: draftWith(a), onlyPaths: true }),
    ).toMatchObject({
      kind: "send",
    });
  });
});

describe("the chip row", () => {
  test("no chips: no row at all (so no height is reserved, P8)", () => {
    expect(attachRowView(EMPTY_DRAFT, 40)).toBeNull();
    expect(attachRowRows(EMPTY_DRAFT, 40)).toBe(0);
  });

  test("chips render as `name size`, and one row is reserved", () => {
    const view = attachRowView(draftWith(chipOf("a.png", 2048)), 60);
    expect(view).toEqual({ kind: "chips", items: ["a.png 2 KB"], more: 0 });
    expect(attachRowRows(draftWith(chipOf("a.png")), 60)).toBe(1);
  });

  test("a nameless ref shows its MIME type", () => {
    expect(chipLabel(anonymous("image/webp", 512))).toBe("image/webp 512 B");
  });

  test("too many chips to fit: the rest is `+N`", () => {
    const chips = [
      chipOf("aaaaaaaaaaaaaaaaaa.png"),
      chipOf("bbbbbbbbbbbbbbbbbb.png"),
      chipOf("cccccccccccccccccc.png"),
    ];
    const view = attachRowView(draftWith(...chips), 30);
    if (view?.kind !== "chips") throw new Error("no chips view");
    expect(view.items.length).toBeLessThan(3);
    expect(view.more).toBe(3 - view.items.length);
    expect(view.more).toBeGreaterThan(0);
  });

  test("a wide input shows every chip with no `+N`", () => {
    const chips = [chipOf("a.png"), chipOf("b.png")];
    expect(attachRowView(draftWith(...chips), 200)).toEqual({
      kind: "chips",
      items: ["a.png 2 KB", "b.png 2 KB"],
      more: 0,
    });
  });

  test("an upload in flight shows progress and the position of N", () => {
    const draft = uploadProgress(draftWith(chipOf("shot.png", 1000)), 0, 2, "shot.png", 500, 1000);
    expect(attachRowView(draft, 60)).toEqual({
      kind: "upload",
      text: "uploading shot.png 50% (1/2)",
    });
    expect(attachRowRows(draft, 60)).toBe(1);
  });

  test("the last byte reads 100%, and a finished upload shows the chips again", () => {
    const done = uploadProgress(draftWith(chipOf("a.png", 10)), 0, 1, "a.png", 10, 10);
    expect(attachRowView(done, 60)).toEqual({ kind: "upload", text: "uploading a.png 100% (1/1)" });
    expect(attachRowView(uploadDone(done), 60)).toMatchObject({ kind: "chips" });
  });
});

describe("imageRowText", () => {
  test("the owner's shape, name first, MIME when nameless (decision 6)", () => {
    expect(imageRowText({ mimeType: "image/png", name: "a.png" })).toBe("[image: a.png]");
    expect(imageRowText({ mimeType: "image/gif" })).toBe("[image: image/gif]");
  });

  test("no sha prefix: the eye sees the name", () => {
    expect(imageRowText({ mimeType: "image/png", name: "a.png" })).not.toContain("sha256");
  });

  test("a hostile name is display text only, never opened (no control chars in the row)", () => {
    const row = imageRowText({ mimeType: "image/png", name: "a b.png" });
    expect(row).toBe("[image: a b.png]");
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting the ABSENCE of one
    expect(/[\u0000-\u001f]/.test(row)).toBe(false);
  });
});

describe("attachErrorText", () => {
  test("images unavailable carries its reason", () => {
    const e = Object.assign(new Error("no vision here"), { name: "ImagesUnavailableError" });
    expect(attachErrorText(e)).toBe("_no vision here_");
  });

  test("an over-cap upload keeps the size sentence", () => {
    expect(attachErrorText(new RangeError("image a.png is 20 MB, over the 15 MB limit"))).toBe(
      "_image a.png is 20 MB, over the 15 MB limit_",
    );
  });

  test("an aborted upload says so", () => {
    const e = Object.assign(new Error("the upload was aborted"), { name: "UploadAbortedError" });
    expect(attachErrorText(e)).toBe("_upload cancelled_");
  });

  test("`not_uploaded` (a serve restart) tells the user to press Enter again", () => {
    const e = Object.assign(new Error("not on this daemon"), {
      code: -32016,
      data: { reason: "not_uploaded" },
    });
    expect(attachErrorText(e)).toContain("Enter");
  });

  test("`images_off` from the daemon says nothing was sent", () => {
    const e = Object.assign(new Error("this model takes no images"), {
      code: -32016,
      data: { reason: "images_off" },
    });
    expect(attachErrorText(e)).toContain("images are off");
  });

  test("an `invalid_ref` refusal shows the daemon's own words", () => {
    const e = Object.assign(new Error("bad ref"), {
      code: -32016,
      data: { reason: "invalid_ref" },
    });
    expect(attachErrorText(e)).toBe("_the daemon refused the image: bad ref_");
  });

  test("a non-Error is still a sentence", () => {
    expect(attachErrorText("boom")).toContain("boom");
    expect(attachErrorText(undefined)).toContain("could not be attached");
  });

  test("matching is by code/name, never by message text: an unrelated error keeps its message", () => {
    // A message that merely mentions the words must not be read as a refusal.
    expect(attachErrorText(new Error("not_uploaded but something else"))).toBe(
      "_not_uploaded but something else_",
    );
  });
});

describe("draftRefs and the no-seam mode", () => {
  test("the refs in chip order", () => {
    const a = chipOf("a.png");
    const b = chipOf("b.png");
    expect(draftRefs(draftWith(a, b))).toEqual([a.ref, b.ref]);
    expect(draftRefs(EMPTY_DRAFT)).toEqual([]);
  });

  test("a session with no seam is OFF, with a reason a person can read", () => {
    expect(NO_IMAGE_SEAM.kind).toBe("off");
    if (NO_IMAGE_SEAM.kind === "off") expect(NO_IMAGE_SEAM.reason.length).toBeGreaterThan(0);
  });
});

describe("looksLikeCommand", () => {
  test("a slash word with no other separator is a command", () => {
    for (const text of ["/help", "/compact", "/attach /tmp/a.png", "/deploy-app", "/img"]) {
      expect(looksLikeCommand(text)).toBe(true);
    }
  });

  test("an absolute path a terminal drags in is NOT a command", () => {
    for (const text of ["/tmp/a.png", "/Users/me/Shot 1.png", "/tmp/shot.jpeg", "/tmp/i.heic"]) {
      expect(looksLikeCommand(text)).toBe(false);
    }
  });

  test("a bare extensionless slash word is a command word; with a second `/` it is a path", () => {
    // `/img` alone cannot be told from a command, and a command must always run;
    // `/tmp/IMG_1` has a nested path, so the drag rule applies (`/attach` is the
    // explicit form where the bytes decide).
    expect(looksLikeCommand("/img")).toBe(true);
    expect(looksLikeCommand("/tmp/IMG_1.png x")).toBe(false);
  });

  test("plain text and a relative path are not commands", () => {
    for (const text of ["hi there", "a.png", "./a.png", "~/Pictures/a.png"]) {
      expect(looksLikeCommand(text)).toBe(false);
    }
  });
});
