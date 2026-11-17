/**
 * `attach-sheet` (docs/feat/pdf-read.md D7): the `+` sheet offers a PDF row ONLY
 * when this session can read one — `upload` mode, the phone's only mode.
 *
 * Red on MUTATION M2, which offers `pdf` whatever the capability says: the
 * pod-session and old-daemon cases would then accept a pick the send must
 * refuse, and on a `laptop` (pod) session would put PDF bytes on a wire AGENTS §7
 * forbids.
 */
import { describe, expect, test } from "bun:test";
import { OLD_DAEMON_DOCUMENTS } from "@tentacle/client";
import { attachSheet, offersPdf } from "../src/attach-sheet.ts";

describe("attachSheet", () => {
  test("upload mode offers the PDF row and needs no reason", () => {
    const sheet = attachSheet({ kind: "upload", maxBytes: 15 * 1024 * 1024 });
    expect(sheet.items).toEqual(["photo", "camera", "pdf"]);
    expect(sheet.reason).toBeNull();
    expect(offersPdf(sheet)).toBe(true);
  });

  test("off mode offers no PDF row and carries the client's own sentence", () => {
    const sheet = attachSheet({ kind: "off", reason: OLD_DAEMON_DOCUMENTS });
    expect(sheet.items).toEqual(["photo", "camera"]);
    expect(sheet.reason).toBe(OLD_DAEMON_DOCUMENTS);
    expect(offersPdf(sheet)).toBe(false);
  });

  test("laptop mode (a pod session) offers no PDF row: the phone cannot extract", () => {
    const sheet = attachSheet({ kind: "laptop", maxBytes: 15 * 1024 * 1024 });
    expect(sheet.items).toEqual(["photo", "camera"]);
    expect(sheet.reason).not.toBeNull();
    expect(offersPdf(sheet)).toBe(false);
  });

  test("the photos rows are never withdrawn", () => {
    for (const input of [
      { kind: "upload", maxBytes: 1 },
      { kind: "laptop", maxBytes: 1 },
      { kind: "off", reason: "x" },
    ] as const) {
      expect(attachSheet(input).items).toContain("photo");
      expect(attachSheet(input).items).toContain("camera");
    }
  });
});
