/**
 * Mermaid source highlighting for the TUI (docs/feat/model-diagrams.md D8):
 * `cli-highlight` has no mermaid grammar, so a tiny tokenizer — keyword, id,
 * arrow, label, comment — whose runs `diagram-lines` paints with theme tokens.
 *
 * Tolerant by design: it never rejects, an unknown character is plain text, and
 * the runs always concatenate back to the input line (pinned by a test).
 *
 * Pure: no I/O, no colour.
 */
import type { DiagramRow, DiagramSeg } from "./diagram-canvas.ts";

const KEYWORDS = new Set([
  "flowchart",
  "graph",
  "sequenceDiagram",
  "classDiagram",
  "stateDiagram",
  "stateDiagram-v2",
  "erDiagram",
  "gantt",
  "mindmap",
  "timeline",
  "journey",
  "gitGraph",
  "subgraph",
  "end",
  "direction",
  "participant",
  "actor",
  "Note",
  "note",
  "over",
  "left",
  "right",
  "of",
  "alt",
  "else",
  "opt",
  "loop",
  "par",
  "and",
  "critical",
  "break",
  "rect",
  "box",
  "activate",
  "deactivate",
  "autonumber",
  "class",
  "state",
  "section",
  "title",
  "dateFormat",
  "axisFormat",
  "commit",
  "branch",
  "checkout",
  "merge",
  "as",
  "TD",
  "TB",
  "BT",
  "LR",
  "RL",
]);

/** Arrow-ish runs: `-->`, `->>`, `-.->`, `==>`, `--x`, `o--o`, `<|--`, `||--o{`… */
const ARROW = /^(?:[<o*x|}{]{0,2}(?:-{1,3}|={2,3}|-\.+-?|\.\.)[->ox|}{*]{0,3}|-[->]+|<<?-+>?>?)/;
const IDENT = /^[\p{L}\p{N}_]+(?:[.-][\p{L}\p{N}_]+)*/u;
const OPEN: Readonly<Record<string, string>> = { "[": "]", "(": ")", "{": "}", "|": "|", '"': '"' };

/** One source line as styled runs (their text joins back to `line`). */
export function highlightMermaidLine(line: string): DiagramRow {
  const out: [DiagramSeg[0], string][] = [];
  const push = (style: DiagramSeg[0], text: string): void => {
    if (text === "") return;
    const last = out[out.length - 1];
    if (last !== undefined && last[0] === style) last[1] += text;
    else out.push([style, text]);
  };
  const trimmed = line.trimStart();
  if (trimmed.startsWith("%%")) {
    push("text", line.slice(0, line.length - trimmed.length));
    push("comment", trimmed);
    return out;
  }
  let i = 0;
  while (i < line.length) {
    const rest = line.slice(i);
    const ch = line[i] as string;
    if (/\s/.test(ch)) {
      push("text", ch);
      i++;
      continue;
    }
    // a sequence message's text, a class member's type, a gantt task's data
    if (ch === ":") {
      push("arrow", ":");
      push("string", rest.slice(1));
      break;
    }
    const close = OPEN[ch];
    if (close !== undefined) {
      // `((x))`, `[(x)]`, `{{x}}`: doubled brackets stay one label
      let depth = 0;
      let j = i;
      while (j < line.length && line[j] === ch && depth < 2) {
        depth++;
        j++;
      }
      const end = line.indexOf(close, j);
      if (end >= 0) {
        let stop = end;
        while (stop < line.length && stop - end < depth && /[\])}|"]/.test(line[stop] as string))
          stop++;
        push("string", line.slice(i, stop));
        i = stop;
        continue;
      }
    }
    const arrow = ARROW.exec(rest);
    if (arrow !== null && arrow[0].length >= 2) {
      push("arrow", arrow[0]);
      i += arrow[0].length;
      continue;
    }
    const ident = IDENT.exec(rest);
    if (ident !== null) {
      push(KEYWORDS.has(ident[0]) ? "keyword" : "id", ident[0]);
      i += ident[0].length;
      continue;
    }
    push("text", ch);
    i++;
  }
  return out;
}
