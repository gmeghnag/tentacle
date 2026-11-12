/**
 * A drag-and-drop paste → local path candidates (docs/feat/attachments-tui-detect.md).
 *
 * A terminal gives a TUI no drop event, only TEXT — whatever form the emulator
 * chose for the file it is handing over:
 *
 * - macOS Terminal.app: `/Users/me/Shot\ 1.png` (backslash-escaped specials)
 * - iTerm2 / Ghostty: `'/Users/me/Shot 1.png'` (or `"…"`)
 * - kitty / VS Code: `file:///Users/me/Shot%201.png` (a URL, percent-encoded)
 * - a typed `~/Pictures/Shot.png`
 *
 * Several files may arrive at once, newline- or space-separated. Owner Q3 (a)
 * decides the rest: the paste becomes attachments only when it is EXCLUSIVELY
 * paths — a path inside a sentence stays text, because the user may be talking
 * about a workspace file rather than handing one over.
 *
 * Pure: no I/O, no React. Whether a decoded path EXISTS (and is an image) is
 * `attach-files.ts`'s question, behind its probe seam.
 */

/** What a paste turned out to be: prose, or one-or-more path candidates. */
export type CandidateText =
  | { readonly kind: "text" }
  | { readonly kind: "paths"; readonly paths: readonly string[] };

export const TEXT_ONLY: CandidateText = { kind: "text" };

export interface TokenizeResult {
  /** The tokens, with quoting and backslash escapes removed. */
  readonly tokens: readonly string[];
  /** False when a quote or an escape was left open — not a drag form. */
  readonly wellFormed: boolean;
}

/**
 * Split `text` into tokens the way a shell would read it: on newlines and on
 * unescaped/unquoted whitespace, with `\c` → `c`, `'…'` literal, `"…"` honouring
 * `\"` and `\\`. A trailing backslash or an unclosed quote makes the whole text
 * `wellFormed: false` (a hand-typed half-quote is prose, not a drop).
 */
export function tokenizePaths(text: string): TokenizeResult {
  const tokens: string[] = [];
  let token = "";
  let started = false;
  let quote: '"' | "'" | null = null;
  let i = 0;
  while (i < text.length) {
    const char = text[i] ?? "";
    if (quote === "'") {
      // Single quotes are literal in every terminal's drag form.
      if (char === "'") {
        quote = null;
      } else {
        token += char;
      }
      i += 1;
      continue;
    }
    if (quote === '"') {
      if (char === '"') {
        quote = null;
      } else if (char === "\\" && (text[i + 1] === '"' || text[i + 1] === "\\")) {
        // Inside DOUBLE quotes only `\"` and `\\` are escapes — a Windows drag
        // form (`"C:\Users\me\x.png"`) keeps its separators, which matters more
        // than shell fidelity here.
        token += text[i + 1] ?? "";
        i += 1;
      } else {
        token += char;
      }
      i += 1;
      continue;
    }
    if (char === "\\") {
      const next = text[i + 1];
      if (next === undefined) {
        return { tokens, wellFormed: false };
      }
      token += next;
      started = true;
      i += 2;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      started = true;
      i += 1;
      continue;
    }
    if (char === "\n" || char === "\r" || char === " " || char === "\t") {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
      i += 1;
      continue;
    }
    token += char;
    started = true;
    i += 1;
  }
  if (quote !== null) {
    return { tokens, wellFormed: false };
  }
  if (started) {
    tokens.push(token);
  }
  return { tokens, wellFormed: true };
}

/** Text after a `file:` scheme, decoded, or null when `token` is not a file URL. */
function fileUrlPath(token: string): string | null {
  if (!/^file:\/\//i.test(token)) {
    return null;
  }
  const rest = token.slice("file://".length);
  // `file:///a/b` → "" host; `file://localhost/a/b` → "localhost". Any other
  // host is a file on ANOTHER machine, which is not a path we can read.
  const slash = rest.indexOf("/");
  const host = slash === -1 ? rest : rest.slice(0, slash);
  if (host !== "" && host.toLowerCase() !== "localhost") {
    return null;
  }
  const encoded = slash === -1 ? "" : rest.slice(slash);
  return percentDecode(encoded);
}

/**
 * `decodeURIComponent`, but a literal `%` that is not an escape stays as it is
 * (a path may legitimately contain `100%`), and nothing is decoded twice — a
 * file literally named `a%20b.png` arrives as `a%2520b.png` and decodes once.
 * An escape RUN is decoded as a unit: `%C3%9C` is one character (`Ü`), so
 * decoding each escape on its own would fail on every non-ASCII name.
 */
function percentDecode(text: string): string {
  return text.replace(/(?:%[0-9a-fA-F]{2})+/g, (run) => {
    try {
      return decodeURIComponent(run);
    } catch {
      return run;
    }
  });
}

/**
 * The local path a token stands for, or null when it is not path-SHAPED.
 *
 * Path-shaped means absolute (`/…`), home-relative (`~`, `~/…`), explicitly
 * relative (`./…`, `../…`), a Windows drive, or a local `file:` URL — the forms
 * a drag produces. A bare relative name (`Shot.png`) is deliberately NOT one:
 * it is indistinguishable from an ordinary word, and `/attach Shot.png` is the
 * explicit way to say it is a file.
 */
export function decodePathToken(token: string, home?: string): string | null {
  if (token === "") {
    return null;
  }
  const url = fileUrlPath(token);
  if (url !== null) {
    return url === "" ? null : url;
  }
  if (token === "~") {
    return home ?? token;
  }
  if (token.startsWith("~/")) {
    return home === undefined ? token : `${home}${token.slice(1)}`;
  }
  if (token.startsWith("/") || token.startsWith("./") || token.startsWith("../")) {
    return token;
  }
  if (/^[A-Za-z]:[\\/]/.test(token)) {
    return token;
  }
  return null;
}

export interface CandidateOptions {
  /** The user's home directory, for `~` expansion. Absent → `~` is left as is. */
  readonly home?: string;
}

/**
 * The owner's rule (Q3 (a)) as one pure function: a paste whose every token is a
 * path candidate IS those paths; anything else — prose with a path in it, an
 * empty paste, an unterminated quote, a bare word — stays text.
 */
export function attachmentCandidateText(
  text: string,
  options: CandidateOptions = {},
): CandidateText {
  const { tokens, wellFormed } = tokenizePaths(text);
  if (!wellFormed || tokens.length === 0) {
    return TEXT_ONLY;
  }
  const paths: string[] = [];
  for (const token of tokens) {
    const path = decodePathToken(token, options.home);
    if (path === null) {
      return TEXT_ONLY;
    }
    paths.push(path);
  }
  return { kind: "paths", paths };
}

export interface AttachCommand {
  /** `/attach` with at least one argument, decoded (quoting removed). */
  readonly kind: "attach";
  readonly paths: readonly string[];
}

/**
 * `/attach <path…>` — the explicit form, so a bare or relative name works
 * without guessing. Not a command when the word is not `/attach` or it carries
 * no argument (the caller then shows the usage line).
 */
export function parseAttachCommand(
  text: string,
  options: CandidateOptions = {},
): AttachCommand | null {
  const trimmed = text.trim();
  if (!/^\/attach(\s|$)/i.test(trimmed)) {
    return null;
  }
  const args = trimmed.slice("/attach".length);
  if (args.trim() === "") {
    return null;
  }
  const { tokens, wellFormed } = tokenizePaths(args);
  if (!wellFormed || tokens.length === 0) {
    return null;
  }
  // Here the user SAID these are files, so every token is taken as written
  // (a bare relative name included); only the drag-specific decoding applies.
  const paths = tokens.map((token) => {
    const url = fileUrlPath(token);
    if (url !== null && url !== "") {
      return url;
    }
    return decodePathToken(token, options.home) ?? token;
  });
  return { kind: "attach", paths };
}
