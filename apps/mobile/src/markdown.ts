/**
 * Markdown for a phone row (12b): `marked`'s lexer → a small, own token tree the
 * row renderers draw. Never HTML — the app renders React elements, so the tree
 * is the deliverable and `marked.parse` is not called at all.
 *
 * Two rules from the plan this module owns:
 * - **a parse is cached per row `version`** (`parseCached`): a streaming answer
 *   re-parses only when its text changed;
 * - **a row over `PARSE_MAX_CHARS` is not parsed**: it is split at a line
 *   boundary into "show more" chunks, so a 1 MB message never parses on the JS
 *   thread (plan F21).
 *
 * Strings from the daemon are DATA: a link token carries its `href` and is
 * never opened here — the screen asks first (plan F22).
 */
import { Lexer, type Token, type Tokens } from "marked";

/** Characters of one row a markdown parse is attempted on (plan F21). */
export const PARSE_MAX_CHARS = 20_000;

/** Rows a "show more" chunk may run to, before the next split. */
export const ROW_CHUNK_LINES = 200;

export type MdInline =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "code"; readonly text: string }
  | { readonly kind: "strong"; readonly children: readonly MdInline[] }
  | { readonly kind: "em"; readonly children: readonly MdInline[] }
  | { readonly kind: "del"; readonly children: readonly MdInline[] }
  /** A link: `href` is shown by the confirmation before anything is opened. */
  | { readonly kind: "link"; readonly href: string; readonly children: readonly MdInline[] };

export type MdBlock =
  | { readonly kind: "paragraph"; readonly children: readonly MdInline[] }
  | { readonly kind: "heading"; readonly depth: number; readonly children: readonly MdInline[] }
  | {
      readonly kind: "list";
      readonly ordered: boolean;
      /** The first number of an ordered list (`1.`), else null. */
      readonly start: number | null;
      readonly items: readonly (readonly MdBlock[])[];
    }
  | { readonly kind: "code"; readonly lang: string | null; readonly text: string }
  /** A table, its cells flattened to monospace text (the phone has no column grid). */
  | {
      readonly kind: "table";
      readonly header: readonly string[];
      readonly rows: readonly (readonly string[])[];
    }
  | { readonly kind: "quote"; readonly children: readonly MdBlock[] }
  | { readonly kind: "rule" }
  /** Markup this module does not render (raw HTML): shown as its own text, never executed. */
  | { readonly kind: "literal"; readonly text: string };

/** A row's parsed markdown: blocks, or the chunks a too-long text was split into. */
export type Parsed =
  | { readonly kind: "blocks"; readonly blocks: readonly MdBlock[] }
  | {
      readonly kind: "chunked";
      /** The first `PARSE_MAX_CHARS` at a line boundary, unparsed (shown as text). */
      readonly shown: string;
      /** How much was held back (`[+N more]`). */
      readonly hidden: number;
    };

/**
 * Undo the HTML escaping `marked@12`'s LEXER applies to inline text, code spans,
 * image alt text and table cells (v12 escapes in the tokenizer, not the renderer,
 * so its tokens carry `&#39;`/`&quot;`/`&amp;`/`&lt;`/`&gt;`). Exactly the set it
 * produces, `&amp;` LAST so `&amp;lt;` stays the text `&lt;` (B3).
 */
export function decodeEntities(text: string): string {
  if (!text.includes("&")) {
    return text;
  }
  return text
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&amp;", "&");
}

function inline(tokens: readonly Token[] | undefined): readonly MdInline[] {
  const out: MdInline[] = [];
  for (const token of tokens ?? []) {
    switch (token.type) {
      case "text":
      case "escape": {
        // A text token may carry inline children of its own (`marked` nests).
        const children = inline((token as Tokens.Text).tokens);
        if (children.length > 0) {
          out.push(...children);
        } else {
          out.push({ kind: "text", text: decodeEntities((token as Tokens.Text).text) });
        }
        break;
      }
      case "codespan":
        out.push({ kind: "code", text: decodeEntities((token as Tokens.Codespan).text) });
        break;
      case "strong":
        out.push({ kind: "strong", children: inline((token as Tokens.Strong).tokens) });
        break;
      case "em":
        out.push({ kind: "em", children: inline((token as Tokens.Em).tokens) });
        break;
      case "del":
        out.push({ kind: "del", children: inline((token as Tokens.Del).tokens) });
        break;
      case "link": {
        const link = token as Tokens.Link;
        out.push({
          kind: "link",
          href: link.href,
          children: inline(link.tokens),
        });
        break;
      }
      case "br":
        out.push({ kind: "text", text: "\n" });
        break;
      case "image": {
        // An image in markdown is a URL this app would have to fetch: it stays text.
        const image = token as Tokens.Image;
        out.push({
          kind: "text",
          text: image.text !== "" ? decodeEntities(image.text) : image.href,
        });
        break;
      }
      default: {
        // `html` and anything unknown: its own source text, rendered as data.
        const raw = (token as { raw?: string }).raw;
        if (raw !== undefined && raw !== "") {
          out.push({ kind: "text", text: raw });
        }
      }
    }
  }
  return out;
}

function blocks(tokens: readonly Token[]): readonly MdBlock[] {
  const out: MdBlock[] = [];
  for (const token of tokens) {
    switch (token.type) {
      case "space":
        break;
      case "paragraph":
        out.push({ kind: "paragraph", children: inline((token as Tokens.Paragraph).tokens) });
        break;
      case "heading": {
        const heading = token as Tokens.Heading;
        out.push({
          kind: "heading",
          depth: heading.depth,
          children: inline(heading.tokens),
        });
        break;
      }
      case "code": {
        const code = token as Tokens.Code;
        out.push({
          kind: "code",
          lang: code.lang !== undefined && code.lang !== "" ? code.lang : null,
          text: code.text,
        });
        break;
      }
      case "list": {
        const list = token as Tokens.List;
        out.push({
          kind: "list",
          ordered: list.ordered === true,
          start: typeof list.start === "number" ? list.start : null,
          items: list.items.map((item) => blocks(item.tokens)),
        });
        break;
      }
      case "table": {
        const table = token as Tokens.Table;
        out.push({
          kind: "table",
          header: table.header.map(cellText),
          rows: table.rows.map((row) => row.map(cellText)),
        });
        break;
      }
      case "blockquote":
        out.push({ kind: "quote", children: blocks((token as Tokens.Blockquote).tokens) });
        break;
      case "hr":
        out.push({ kind: "rule" });
        break;
      case "html": {
        const html = token as Tokens.HTML;
        out.push({ kind: "literal", text: html.text });
        break;
      }
      case "text": {
        // A loose list item's body arrives as a `text` block with children.
        const text = token as Tokens.Text;
        const nested = text.tokens;
        if (nested?.some((t) => t.type === "list" || t.type === "code") === true) {
          out.push(...blocks(nested));
        } else {
          out.push({ kind: "paragraph", children: inline(nested) });
        }
        break;
      }
      default: {
        const raw = (token as { raw?: string }).raw;
        if (raw !== undefined && raw.trim() !== "") {
          out.push({ kind: "literal", text: raw });
        }
      }
    }
  }
  return out;
}

function cellText(cell: Tokens.TableCell): string {
  return flatten(inline(cell.tokens));
}

/** Inline items as one string (a table cell, a row's plain-text search). */
export function flatten(items: readonly MdInline[]): string {
  return items
    .map((item) => {
      switch (item.kind) {
        case "text":
        case "code":
          return item.text;
        case "link":
          return flatten(item.children);
        default:
          return flatten(item.children);
      }
    })
    .join("");
}

/** The longest prefix of `text` under the cap, cut at a line boundary. */
export function boundText(text: string, cap: number = PARSE_MAX_CHARS): Parsed {
  if (text.length <= cap) {
    return { kind: "blocks", blocks: blocks(Lexer.lex(text)) };
  }
  const cut = text.lastIndexOf("\n", cap);
  const at = cut > 0 ? cut : cap;
  return { kind: "chunked", shown: text.slice(0, at), hidden: text.length - at };
}

/**
 * Parse one row's markdown for display. Over the cap, nothing is parsed: the
 * text is shown up to a line boundary with what was held back (plan F21).
 */
export function parse(text: string): Parsed {
  return boundText(text);
}

/**
 * A parse cache keyed by row key + version: a streaming answer re-parses only
 * when its text actually changed, and a replaced transcript drops the old keys.
 */
export interface ParseCache {
  get(key: string, version: number, text: () => string): Parsed;
  /** Forget every entry whose key is not in `keep` (a history replacement). */
  retain(keep: ReadonlySet<string>): void;
  readonly size: number;
}

export function createParseCache(limit = 400): ParseCache {
  const entries = new Map<string, { readonly version: number; readonly parsed: Parsed }>();
  return {
    get(key, version, text) {
      const hit = entries.get(key);
      if (hit !== undefined && hit.version === version) {
        return hit.parsed;
      }
      const parsed = parse(text());
      entries.delete(key);
      entries.set(key, { version, parsed });
      if (entries.size > limit) {
        const oldest = entries.keys().next();
        if (!oldest.done) {
          entries.delete(oldest.value);
        }
      }
      return parsed;
    },
    retain(keep) {
      for (const key of [...entries.keys()]) {
        if (!keep.has(key)) {
          entries.delete(key);
        }
      }
    },
    get size() {
      return entries.size;
    },
  };
}

/** The inline source of a `text`/`code` token list, for a accessibility label. */
export function plainText(parsed: Parsed): string {
  if (parsed.kind === "chunked") {
    return parsed.shown;
  }
  const out: string[] = [];
  const walk = (list: readonly MdBlock[]): void => {
    for (const block of list) {
      switch (block.kind) {
        case "paragraph":
        case "heading":
          out.push(flatten(block.children));
          break;
        case "code":
          out.push(block.text);
          break;
        case "list":
          for (const item of block.items) {
            walk(item);
          }
          break;
        case "table":
          out.push(block.header.join(" "));
          for (const row of block.rows) {
            out.push(row.join(" "));
          }
          break;
        case "quote":
          walk(block.children);
          break;
        case "literal":
          out.push(block.text);
          break;
        case "rule":
          break;
      }
    }
  };
  walk(parsed.blocks);
  return out.join("\n");
}
