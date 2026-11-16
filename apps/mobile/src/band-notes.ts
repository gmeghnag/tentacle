/**
 * A section's notes, as BLOCKS (docs/feat/mobile-chrome.md Design 4; fix round 1
 * of the S4 review, finding 1).
 *
 * A section can carry three notes — `rowsNote` ("and 3 more"), `footer` ("1 of 2
 * connected") and `switchNote` (why the switches are off). They are three
 * PARAGRAPHS under a band (as they were before S4), never one running line, so
 * the component needs one block per note and one key per block. Both decisions
 * live here, pure, so they are asserted without rendering anything (AGENTS §7):
 *
 * - **one entry per note**, in reading order (the cap, then the count, then what
 *   the switches do) — an empty/whitespace note is not a block;
 * - **the key is the note's ROLE, not its text**: two notes can legitimately say
 *   the same words, and a text key would then be a duplicate React key (the S4
 *   review's nit) — React would drop or reorder one of them.
 *
 * `screens/SessionInfoSheet.tsx` is the only caller and it only renders what this
 * returns (`ui/BandSection.tsx`'s `BandNote` is the block it renders into).
 */
import type { InfoSection } from "./session-info.ts";

/** One note under a band: what it says, and who it is (for a key and a testID). */
export interface BandNote {
  /** Stable React key: the note's role in the section. */
  readonly key: "rowsNote" | "footer" | "switchNote";
  readonly text: string;
  /** Set on the switch note only: flows/tests target it by section. */
  readonly testID?: string;
}

/**
 * The section's notes in reading order. `switchNote` keeps its testID
 * (`session-info-switch-note-<section>`) — the id must ride on a REAL view, which
 * is why the note is its own block and not a nested text run (fix round 1).
 */
export function sectionNotes(
  section: Pick<InfoSection, "id" | "rowsNote" | "footer" | "switchNote">,
): readonly BandNote[] {
  const notes: BandNote[] = [];
  if (section.rowsNote !== undefined && section.rowsNote.trim() !== "") {
    notes.push({ key: "rowsNote", text: section.rowsNote });
  }
  if (section.footer !== undefined && section.footer.trim() !== "") {
    notes.push({ key: "footer", text: section.footer });
  }
  if (section.switchNote !== undefined && section.switchNote.trim() !== "") {
    notes.push({
      key: "switchNote",
      text: section.switchNote,
      testID: `session-info-switch-note-${section.id}`,
    });
  }
  return notes;
}
