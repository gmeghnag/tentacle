/**
 * Mermaid's own parser, daemon-side (docs/feat/model-diagrams.md D4): the one
 * place that decides whether a diagram is valid, so a diagram the daemon
 * accepted is one every client can draw (one pinned version, T2.6).
 *
 * Mermaid is a browser library. Its sanitiser (DOMPurify) binds to `window` when
 * the module is EVALUATED and is a no-op stub without one, which crashes every
 * flowchart-family parse (the D2 probe). So the import runs under a minimal
 * `linkedom` DOM — and only the import: the globals are restored as soon as it
 * settles, because a `window` left in the daemon would flip every library that
 * sniffs for a browser. Probe-verified (plain `bun` and a compiled binary): every
 * allowed type parses with the globals already gone.
 *
 * Lazy on purpose: a session that never draws a diagram never loads mermaid
 * (~3.8 MiB of the binary, measured by the probe), and a build that lacks it
 * answers "not available" instead of crashing (T2.4).
 */

/** Mermaid's `parse`: resolves on a valid source, throws its own error otherwise. */
export type MermaidParser = (source: string) => Promise<unknown>;

export type MermaidParseOutcome =
  | { readonly ok: true }
  /** Mermaid refused the source; `error` is its raw error, for `explainMermaidError`. */
  | { readonly ok: false; readonly reason: "invalid"; readonly error: unknown }
  /** This build could not load mermaid (`detail` is why, for logs — not the model). */
  | { readonly ok: false; readonly reason: "unavailable"; readonly detail: string }
  /** The parse did not settle within the budget. */
  | { readonly ok: false; readonly reason: "timeout" };

export interface ParseMermaidOptions {
  /** Test seam: what loads mermaid. Default: {@link loadMermaid}. */
  readonly loader?: () => Promise<MermaidParser>;
  /** Milliseconds the parse itself may take (the import is not counted). */
  readonly budgetMs?: number;
}

/** The parse budget (Owner Q8): a pathological source is refused, not waited on. */
export const MERMAID_PARSE_BUDGET_MS = 2000;

/** The globals DOMPurify and mermaid read while their modules evaluate. */
const SHIM_KEYS = ["window", "document", "DOMParser", "Element", "Node", "HTMLElement"] as const;

/** Import mermaid under a DOM that exists only for the import. */
async function loadMermaid(): Promise<MermaidParser> {
  const { parseHTML } = await import("linkedom");
  const { window } = parseHTML("<!doctype html><html><body></body></html>");
  const g = globalThis as Record<string, unknown>;
  const dom = window as unknown as Record<string, unknown>;
  const saved = SHIM_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(g, key)] as const);
  for (const key of SHIM_KEYS) g[key] = key === "window" ? window : dom[key];
  try {
    const mermaid = (await import("mermaid")).default;
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      // Nothing on stdout/stderr: in the in-process worker the terminal is Ink's (AGENTS §7).
      logLevel: "fatal",
      maxEdges: 500,
    });
    return (source) => mermaid.parse(source);
  } finally {
    for (const [key, descriptor] of saved) {
      if (descriptor === undefined) Reflect.deleteProperty(g, key);
      else Object.defineProperty(g, key, descriptor);
    }
  }
}

/**
 * One load, shared by every call; a FAILED load is forgotten, so the next call
 * retries it instead of answering "not available" for the process's lifetime.
 */
export function cachedMermaidLoader(
  load: () => Promise<MermaidParser>,
): () => Promise<MermaidParser> {
  let loaded: Promise<MermaidParser> | undefined;
  return () => {
    if (loaded === undefined) {
      const attempt = load();
      loaded = attempt;
      attempt.catch(() => {
        if (loaded === attempt) loaded = undefined;
      });
    }
    return loaded;
  };
}

const defaultLoader = cachedMermaidLoader(loadMermaid);

/**
 * Parse `source` with mermaid. Never throws: every outcome is a value the tool
 * turns into a sentence. The budget races an ASYNC hang; a synchronous loop
 * inside mermaid would block the thread regardless (no worker isolation here).
 */
export async function parseMermaid(
  source: string,
  options: ParseMermaidOptions = {},
): Promise<MermaidParseOutcome> {
  let parse: MermaidParser;
  try {
    parse = await (options.loader ?? defaultLoader)();
  } catch (error) {
    return {
      ok: false,
      reason: "unavailable",
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  const budget = options.budgetMs ?? MERMAID_PARSE_BUDGET_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), budget);
  });
  try {
    const settled = await Promise.race([
      // `then` first, so a parser that throws synchronously is an `invalid` too.
      Promise.resolve()
        .then(() => parse(source))
        .then(
          () => ({ ok: true }) as const,
          (error: unknown) => ({ ok: false, reason: "invalid", error }) as const,
        ),
      timeout,
    ]);
    return settled === "timeout" ? { ok: false, reason: "timeout" } : settled;
  } finally {
    clearTimeout(timer);
  }
}
