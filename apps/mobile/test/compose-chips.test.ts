/**
 * The photo chips of one message (docs/feat/mobile-compose.md 13d): what a pick
 * adds, how a chip moves, and what a send takes. Pure — no Expo, no React.
 */
import { describe, expect, test } from "bun:test";
import {
  CHIP_CAP,
  type Chip,
  type Chips,
  addPicks,
  chipDocumentReady,
  chipFiles,
  chipRefused,
  chipRemoved,
  chipTestId,
  chipUploaded,
  counted,
  pickRoom,
  splitTaken,
  takeChips,
} from "../src/compose-chips.ts";

function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `k${n}`;
  };
}

const PICK = {
  kind: "ready" as const,
  file: "file:///photos/a.jpg",
  mimeType: "image/jpeg",
  name: "a.jpg",
};

describe("a pick becomes chips (F13–F15, F22)", () => {
  test("each photo is an uploading chip with its own stable key", () => {
    const { chips, refused } = addPicks([], [PICK, PICK], counter());
    expect(refused).toBe(0);
    expect(chips.map((chip) => chip.key)).toEqual(["k1", "k2"]);
    expect(chips.every((chip) => chip.state === "uploading")).toBe(true);
  });

  test("a refused pick is a chip with its reason, not a lost photo", () => {
    const { chips } = addPicks(
      [],
      [{ kind: "refused", detail: "the image is larger than 15 MiB" }],
      counter(),
    );
    expect(chips).toHaveLength(1);
    expect(chips[0]?.state === "refused" && chips[0].detail).toContain("15 MiB");
  });

  test("a refused chip does not hold one of the five slots", () => {
    // Mutation: count every chip → the 5th ready photo is refused as `too-many` → red.
    const full: Chips = [
      { key: "a", state: "refused", detail: "too large" },
      ...Array.from(
        { length: CHIP_CAP - 1 },
        (_, i): Chip => ({
          key: `r${i}`,
          kind: "image",
          state: "uploading",
          file: `f${i}`,
          mimeType: "image/png",
          name: `${i}.png`,
        }),
      ),
    ];
    expect(counted(full)).toBe(CHIP_CAP - 1);
    const { chips, refused } = addPicks(full, [PICK], counter());
    expect(refused).toBe(0);
    expect(counted(chips)).toBe(CHIP_CAP);
  });

  test("more than five: the extras are refused, visibly", () => {
    const { chips, refused } = addPicks(
      [],
      Array.from({ length: 7 }, () => PICK),
      counter(),
    );
    expect(refused).toBe(2);
    expect(counted(chips)).toBe(CHIP_CAP);
    expect(chips.filter((chip) => chip.state === "refused")).toHaveLength(2);
  });

  test("the picker's room is what is left of the five", () => {
    expect(pickRoom([])).toBe(CHIP_CAP);
    expect(
      pickRoom([
        {
          key: "a",
          kind: "image",
          state: "uploading",
          file: "f",
          mimeType: "image/png",
          name: "a.png",
        },
      ]),
    ).toBe(CHIP_CAP - 1);
    // A refused chip takes no room.
    expect(pickRoom([{ key: "a", state: "refused", detail: "x" }])).toBe(CHIP_CAP);
  });
});

// `Chip` is imported above for the partial-cap array.

describe("a chip's progress (D5: upload at pick)", () => {
  test("uploaded → ready, carrying the daemon's blob id", () => {
    const chips = addPicks([], [PICK], counter()).chips;
    const done = chipUploaded(chips, "k1", "blob-1", 1234);
    expect(done[0]).toMatchObject({ state: "ready", ref: { id: "blob-1", size: 1234 } });
  });

  test("a refusal lands on the chip and nothing else moves (F17)", () => {
    const chips = addPicks([], [PICK, PICK], counter()).chips;
    const refused = chipRefused(chips, "k2", "that computer cannot take images");
    expect(refused.map((chip) => chip.state)).toEqual(["uploading", "refused"]);
    const second = refused[1];
    expect(second === undefined ? "" : chipTestId(1, second)).toBe("chip-1-refused");
  });

  test("an unknown key changes nothing (a late answer after a removal)", () => {
    const chips = addPicks([], [PICK], counter()).chips;
    expect(chipUploaded(chips, "gone", "blob", 1)).toEqual(chips);
    expect(chipRefused(chips, "gone", "x")).toEqual(chips);
  });

  test("a removed chip is gone, and its slot is free again", () => {
    const chips = addPicks([], [PICK, PICK], counter()).chips;
    const removed = chipRemoved(chips, "k1");
    expect(removed.map((chip) => chip.key)).toEqual(["k2"]);
    expect(pickRoom(removed)).toBe(CHIP_CAP - 1);
    expect(chipFiles(removed)).toEqual(["file:///photos/a.jpg"]);
  });
});

describe("a send takes the chips ONCE (D1, F4: a double tap sends one message)", () => {
  const uploaded = (): Chips =>
    chipUploaded(
      chipUploaded(addPicks([], [PICK, PICK], counter()).chips, "k1", "b1", 10),
      "k2",
      "b2",
      20,
    );

  test("ready chips are taken and cleared in the same call", () => {
    const first = takeChips(uploaded());
    expect(first.taken.map((chip) => (chip.kind === "image" ? chip.id : ""))).toEqual(["b1", "b2"]);
    expect(first.taken[0]).toMatchObject({ kind: "image", mimeType: "image/jpeg" });
    expect(first.chips).toEqual([]);
    // The second call has nothing left: the same message cannot go twice.
    expect(takeChips(first.chips).taken).toEqual([]);
  });

  test("an uploading chip is NOT taken, and is counted (its item waits for it)", () => {
    // Mutation: take an uploading chip → its ref id is empty and the message
    // would name a blob the daemon never got → red.
    const chips = addPicks([], [PICK], counter()).chips;
    const taken = takeChips(chips);
    expect(taken.taken).toEqual([]);
    expect(taken.uploading).toBe(1);
    expect(taken.chips).toHaveLength(1);
  });

  test("a refused chip is dropped on send (it was never going out)", () => {
    const chips = addPicks([], [{ kind: "refused", detail: "nope" }], counter()).chips;
    expect(takeChips(chips).chips).toEqual([]);
  });
});
describe("a PDF is a chip too (docs/feat/pdf-read.md D7)", () => {
  /** What `attachDocument` answers: the block a prompt names (D6/D7). */
  const BLOCK = {
    type: "document",
    kind: "pdf",
    name: "report.pdf",
    source: { type: "ref", id: "a".repeat(64), size: 2048 },
  } as const;
  const PDF_PICK = {
    kind: "document" as const,
    file: "file:///pdfs/7-1-report.pdf",
    name: "report.pdf",
    size: 2048,
    bytes: new Uint8Array([1, 2, 3]),
  };

  test("the chip keeps its KIND, so the glyph is not guessed from the extension", () => {
    // Mutation: drop `kind` from the chip → `undefined` here → red.
    const { chips } = addPicks([], [PICK], counter());
    expect(chips[0]).toMatchObject({ kind: "image" });
    expect(addPicks([], [PDF_PICK], counter()).chips[0]).toMatchObject({
      kind: "document",
      name: "report.pdf",
      size: 2048,
    });
  });

  test("a document chip has no mime type (the wire's block names a kind, not a type)", () => {
    const chip = addPicks([], [PDF_PICK], counter()).chips[0];
    expect(chip === undefined ? undefined : "mimeType" in chip).toBe(false);
  });

  test("a PDF counts toward the same five as a photo", () => {
    // Mutation: count only images → a sixth attachment would be accepted → red.
    const photos = addPicks(
      [],
      Array.from({ length: CHIP_CAP }, () => PICK),
      counter(),
    ).chips;
    expect(counted(photos)).toBe(CHIP_CAP);
    const { chips, refused } = addPicks(photos, [PDF_PICK], counter());
    expect(refused).toBe(1);
    expect(counted(chips)).toBe(CHIP_CAP);
  });

  test("an unattached document takes no slot on a send; the attached one carries its block", () => {
    const chips = addPicks([], [PDF_PICK], counter()).chips;
    expect(takeChips(chips).taken).toEqual([]);
    const ready = chipDocumentReady(chips, "k1", BLOCK);
    expect(takeChips(ready).taken).toEqual([
      {
        kind: "document",
        key: "k1",
        file: "file:///pdfs/7-1-report.pdf",
        name: "report.pdf",
        size: 2048,
        block: BLOCK,
      },
    ]);
  });

  test("a send splits the taken chips back into photos and documents", () => {
    const ready = chipDocumentReady(addPicks([], [PICK, PDF_PICK], counter()).chips, "k2", BLOCK);
    const { taken } = takeChips(chipUploaded(ready, "k1", "blob-1", 10));
    const split = splitTaken(taken);
    expect(split.photos).toHaveLength(1);
    expect(split.documents).toEqual([
      {
        key: "k2",
        file: "file:///pdfs/7-1-report.pdf",
        name: "report.pdf",
        size: 2048,
        block: BLOCK,
      },
    ]);
  });

  test("a document chip's testID is unchanged (the Maestro contract)", () => {
    const chip = addPicks([], [PDF_PICK], counter()).chips[0];
    expect(chip === undefined ? "" : chipTestId(0, chip)).toBe("chip-0-uploading");
  });
});
