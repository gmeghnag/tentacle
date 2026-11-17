/**
 * A PDF in a transcript row (docs/feat/pdf-read.md D5/D7, slice P6): the phone
 * shows the file the person attached, never the text the model was given.
 *
 * The rule is the TUI's (`packages/tui/src/pdf-attach.ts`, P5): a user message
 * WITH `media` hides its `<file …>` blocks and names each attachment on one
 * `[pdf: name · N pp]` row; a message WITHOUT `media` is shown RAW — an older
 * log, or a daemon that did not record the chip, is never guessed at. This file
 * pins the phone's copy of that rule to the TUI's own functions, and pins the
 * one live case the wire can answer: this phone's own prompt, whose names the
 * compose half knows.
 *
 * The row's DRAWING cannot run here (React Native has no renderer under
 * `bun test`), so it is pinned by reading the source — the
 * `schedule-wiring.test.ts` pattern.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type ChatMessage, attachedDocument } from "@tentacle/core";
import {
  documentRowText as tuiDocumentRowText,
  mediaRowText as tuiMediaRowText,
} from "../../../packages/tui/src/pdf-attach.ts";
import { documentRowText, mediaRowText } from "../src/transcript-rows.ts";
import { type State, apply, initialState } from "../src/transcript.ts";

/** The block the daemon appends to a user message's text, and the chip it records. */
const attached = attachedDocument({
  name: "report.pdf",
  pages: 2,
  text: "--- page 1 / 2 ---\nthe body",
});

describe("the row text (the TUI's wording, one rule)", () => {
  test("a known page count is shown; an unknown one is not invented", () => {
    expect(documentRowText("report.pdf", 2)).toBe("[pdf: report.pdf · 2 pp]");
    expect(documentRowText("report.pdf")).toBe("[pdf: report.pdf]");
    // A page count that is not a count (0) is not one either.
    expect(documentRowText("report.pdf", 0)).toBe("[pdf: report.pdf]");
    expect(documentRowText("report.pdf", 2)).toBe(tuiDocumentRowText("report.pdf", 2));
    expect(documentRowText("report.pdf")).toBe(tuiDocumentRowText("report.pdf"));
  });

  test("a media entry is named by its kind; an unknown kind is labelled, never dropped", () => {
    expect(mediaRowText({ kind: "pdf", name: "report.pdf", pages: 2 })).toBe(
      "[pdf: report.pdf · 2 pp]",
    );
    // A newer daemon's kind (the field is a free string): still a fact about the message.
    expect(mediaRowText({ kind: "audio", name: "memo.m4a" })).toBe("[audio: memo.m4a]");
    // The phone and the TUI name an attachment the same way.
    expect(mediaRowText({ kind: "pdf", name: "report.pdf", pages: 2 })).toBe(
      tuiMediaRowText({ kind: "pdf", name: "report.pdf", pages: 2 }),
    );
    expect(mediaRowText({ kind: "audio", name: "memo.m4a" })).toBe(
      tuiMediaRowText({ kind: "audio", name: "memo.m4a" }),
    );
  });
});

function fold(messages: readonly ChatMessage[]): State {
  return apply(initialState, { type: "history", messages, reason: null });
}

describe("a history row with an attached PDF", () => {
  test("the block is hidden and the file is named (one row per attachment)", () => {
    // MUTATION M3: ignore `media` in `transcript-history.ts` → this test is red
    // (the raw `<file …>` block and its text come back).
    const state = fold([
      {
        role: "user",
        content: `summarise this\n${attached.block}`,
        media: [attached.media],
      },
    ]);
    const row = state.rows[0];
    expect(row?.kind).toBe("user");
    if (row?.kind !== "user") {
      throw new Error("expected a user row");
    }
    expect(row.text).toBe("summarise this");
    expect(row.documents).toEqual(["[pdf: report.pdf · 2 pp]"]);
    // The block's own text is NOWHERE: the model has it, the person has the file.
    expect(row.text).not.toContain("the body");
    expect(row.text).not.toContain("<file");
  });

  test("a PDF-only prompt: no text left, its row alone (the row is the whole bubble)", () => {
    const state = fold([{ role: "user", content: attached.block, media: [attached.media] }]);
    const row = state.rows[0];
    expect(row?.kind).toBe("user");
    if (row?.kind !== "user") {
      throw new Error("expected a user row");
    }
    expect(row.text).toBe("");
    expect(row.documents).toHaveLength(1);
  });

  test("NO media (an older log): the content is RAW — never a guess about which block", () => {
    const raw = `hello\n${attached.block}`;
    const row = fold([{ role: "user", content: raw }]).rows[0];
    expect(row?.kind).toBe("user");
    if (row?.kind !== "user") {
      throw new Error("expected a user row");
    }
    expect(row.text).toBe(raw);
    expect(row.documents).toBeUndefined();
    // …and an EMPTY media list is the same absence, not "there was a file".
    const empty = fold([{ role: "user", content: raw, media: [] }]).rows[0];
    expect(empty?.kind === "user" ? empty.documents : "not a user row").toBeUndefined();
  });
});

describe("this phone's own prompt (D7: the names the compose half knows)", () => {
  const ownPrompt = (documents?: readonly string[]) =>
    apply(initialState, {
      type: "own_prompt",
      text: "",
      ...(documents === undefined ? {} : { documents }),
    });

  test("a PDF-only prompt is a ROW: its labels are the whole message", () => {
    const row = ownPrompt(["[pdf: report.pdf]"]).rows[0];
    expect(row?.kind).toBe("user");
    if (row?.kind !== "user") {
      throw new Error("expected a user row");
    }
    expect(row.text).toBe("");
    expect(row.documents).toEqual(["[pdf: report.pdf]"]);
  });

  test("no documents: the row carries no key at all (a text-only prompt is unchanged)", () => {
    const row = ownPrompt().rows[0];
    expect(row?.kind).toBe("user");
    expect(row?.kind === "user" ? row.documents : "not a user row").toBeUndefined();
  });
});

describe("the bubble draws them", () => {
  test("TranscriptRow renders one labelled line per `user.documents` entry", () => {
    const row = readFileSync(
      join(import.meta.dir, "..", "src", "screens", "transcript", "TranscriptRow.tsx"),
      "utf8",
    );
    // The row's own field, the pure module's helper (never a second copy of the
    // wording in the component), and a testID a flow can find.
    expect(row).toContain("user.documents");
    expect(row).toContain('testID="row-documents"');
    expect(row).toContain('name="doc.on.doc"');
  });
});
