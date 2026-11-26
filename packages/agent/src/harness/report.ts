/**
 * The sub-agent report as ordered SEGMENTS, so a remote stream that REPLACES an
 * artifact's text (A2A `append:false`) retracts what it replaced instead of
 * letting the parent read the answer twice (docs/fix/a2a-stream-duplicate.md).
 *
 * Pure and React-free (AGENTS §7): the runner maps its events onto this buffer,
 * this decides the text. One invariant keeps every other adapter untouched:
 * with no `replace` event the joined segments are byte-identical to the plain
 * `report += …` concatenation the runner used to do.
 */

import type { HarnessEvent } from "./types.ts";

/** The `output` member of `HarnessEvent` (what `applyOutput` consumes). */
export type OutputEvent = Extract<HarnessEvent, { kind: "output" }>;

/**
 * One run of report text. `id` is the artifact it came from (A2A
 * `artifactId`); `""` is the plain tail — the text of no artifact (notices,
 * a stateless `message`, a non-A2A adapter's output).
 */
export interface ReportSegment {
  id: string;
  text: string;
}

export interface ReportBuffer {
  segments: ReportSegment[];
}

/** A data part is JSON in the report; capped like every other remote payload. */
const DATA_CAP = 4096;

function capped(text: string): string {
  return text.length > DATA_CAP ? `${text.slice(0, DATA_CAP)}… (${text.length} chars)` : text;
}

export function createReport(): ReportBuffer {
  return { segments: [] };
}

/** Append to `id`'s segment, or start a new one when the last segment is another's. */
function push(buf: ReportBuffer, id: string, text: string): void {
  const last = buf.segments[buf.segments.length - 1];
  if (last !== undefined && last.id === id) last.text += text;
  else buf.segments.push({ id, text });
}

/** Text added to the plain tail: a notice, the end's text, a cancellation note. */
export function appendReport(buf: ReportBuffer, text: string): void {
  push(buf, "", text);
}

/** The report becomes exactly `text` (the runner's two reset sites). */
export function setReport(buf: ReportBuffer, text: string): void {
  buf.segments.length = 0;
  push(buf, "", text);
}

/**
 * One `output` event. A `replace` event empties ITS artifact's text first (and
 * carries none itself), so what follows is the artifact's content, rewritten —
 * other artifacts and the plain tail keep their own text and their order.
 */
export function applyOutput(buf: ReportBuffer, ev: OutputEvent): void {
  const id = ev.fromArtifact ?? "";
  if (ev.replace) {
    for (const s of buf.segments) if (s.id === id) s.text = "";
  }
  if (ev.text) push(buf, id, ev.text);
  if (ev.data !== undefined) push(buf, id, `\n${capped(JSON.stringify(ev.data) ?? "")}`);
  if (ev.file) {
    const f = ev.file;
    push(
      buf,
      id,
      `\n[file] ${f.name ?? "(unnamed)"} (${f.mediaType ?? "unknown type"}${f.bytes !== undefined ? `, ${f.bytes} bytes` : ""}) — listed, not saved`,
    );
  }
}

/** The report as the one string the parent reads. */
export function reportText(buf: ReportBuffer): string {
  return buf.segments.map((s) => s.text).join("");
}
