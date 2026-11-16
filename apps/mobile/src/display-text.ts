/**
 * The phone's display sanitizer for DAEMON and MODEL strings — one rule, in one
 * place, because three surfaces draw such text (Session info, the schedule rows,
 * a fired turn's head) and a second copy would drift.
 *
 * Bidi overrides/isolates and zero-width characters out, one line, bounded
 * (`oneLine`'s rule in the TUI, `commands.ts:56-64`). The wire rejects control
 * characters only, and the daemon is trusted — but a skill's DESCRIPTION is a
 * file on disk, and a schedule's `spec`/`prompt` are a MODEL's words, which are
 * not.
 */
export function sanitizeDisplay(text: string): string {
  const cleaned = text
    // Bidi: overrides, embeddings, isolates and the marks.
    .replace(/[\u202a-\u202e\u2066-\u2069\u200e\u200f\u061c]/g, "")
    // Zero-width and the BOM (an ALTERNATION, not a class: a zero-width joiner
    // composes several emoji into one, which a character class cannot express).
    .replace(/\u200b|\u200c|\u200d|\u2060|\ufeff/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length <= 300 ? cleaned : `${cleaned.slice(0, 299)}…`;
}
