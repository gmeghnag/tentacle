/**
 * The pure pruner (docs/feat/smart-compaction.md, S1): a lossless-first
 * projection of the STORED history for the model's request.
 *
 * Nothing here touches the stored messages. `pruneCandidates` reads a history
 * and describes, per index, the stub that should replace it; `applyPrune`
 * builds the copy. The plan's rules:
 *
 * - R1 `superseded_read` — an `fs_read` result a later read of the same path
 *   covering the same span (same or wider line range; for a PDF the SAME
 *   `pages` window) or a later successful write/edit of that path made stale.
 *   A page window is never "covered" by a line range or vice versa.
 * - R2 `call_payload` — the `content`/`old_string`/`new_string`/`edits[].*`
 *   arguments of a SUCCESSFUL write/edit: the file on disk is the truth.
 * - R3 `long_output` — a `shell`/`shell_output` result past `outputChars`:
 *   keep the header (the exit code), the first `headLines` and the last
 *   `tailLines` (errors live in the tail).
 * - R4 `spill_preview` — a spilled result's preview, when the full output is on
 *   disk: keep the banner that names the file.
 * - R5 `duplicate` — a result byte-identical to a LATER result of the same tool
 *   with the same arguments.
 *
 * Never a candidate: user/assistant **text**, the protected tail (the last
 * `keepRecentRounds` assistant rounds — always including the current turn), and
 * the results of the curated tools (`skill`, `context_reset`).
 *
 * Every stub is a deterministic function of the stored history (no clock, no
 * counter), so the same bytes are sent every round and the provider's prefix
 * cache holds between batches. An entry pins the message it was built from, so
 * a set never fires on a different history that reuses its indices (the history
 * is replaced IN PLACE by `/compact`, `/clear` and `context_reset`).
 */
import {
  type ChatMessage,
  IMAGE_TOKEN_ESTIMATE,
  IMAGE_VIEW_TOOL_NAME,
  type ToolCall,
} from "@tentacle/core";
import { CONTEXT_RESET_TOOL_NAME, PRUNE_SENTINEL, SKILL_TOOL_NAME } from "@tentacle/tools";

/**
 * The unmistakable sentinel every stub carries — `@tentacle/tools`'
 * `PRUNE_SENTINEL`, ONE value: the write tools refuse it (followed by the
 * stub's colon) as input, so a model that copies a placeholder into a real
 * write gets a clear error instead of corrupting a file.
 */
export const PRUNE_MARKER = PRUNE_SENTINEL;

/** What a candidate is pruned by. */
export type PruneRule =
  | "superseded_read"
  | "call_payload"
  | "long_output"
  | "spill_preview"
  | "duplicate"
  | "viewed_image";

/** One pruned message: the replacement, why, and what it saves. */
export interface PruneEntry {
  readonly rule: PruneRule;
  /**
   * The STORED message the entry was built from, by reference. An index alone
   * cannot tell a live entry from a stale one: `/compact`, `/clear` and
   * `context_reset` replace the history IN PLACE, reusing the same array
   * (`session.ts:366-367`, `:390-391`; `agent.ts` resets the same way), so a
   * set made before the replacement still has in-range indices — and would
   * stub whatever now sits there (a `/compact` summary, say).
   */
  readonly original: ChatMessage;
  /** The message that replaces the stored one at this index (always a new object). */
  readonly message: ChatMessage;
  /**
   * Characters the request no longer carries (>= 1, except a `viewed_image`
   * stub, whose gain is its image: it may be a little LONGER than the line it replaces).
   */
  readonly savedChars: number;
  /** Image refs the stub drops (`viewed_image`): counted by `estimateGain` at `imageTokens` each. */
  readonly savedImages?: number;
}

/** Message index in the stored history → its pruned replacement. */
export type PruneSet = ReadonlyMap<number, PruneEntry>;

export interface PruneOptions {
  /** Assistant rounds at the end of the history never pruned (default 6). */
  readonly keepRecentRounds?: number;
  /** A `shell`/`shell_output` result over this many chars is R3 (default 2000). */
  readonly outputChars?: number;
  /** R3 keeps this many leading content lines after the header (default 10). */
  readonly headLines?: number;
  /** R3 keeps this many trailing lines (default 30). */
  readonly tailLines?: number;
  /** What one dropped image ref saves, in tokens (`estimateGain`; default 1600). */
  readonly imageTokens?: number;
}

/** The defaults the plan fixes; S2/S3 retune them through config. */
export const PRUNE_DEFAULTS = {
  keepRecentRounds: 6,
  outputChars: 2000,
  headLines: 10,
  tailLines: 30,
} as const;

/**
 * Tools whose results are curated context, never transformed
 * (`exemptTools` in result-pipeline.ts names the same intent): a skill body is
 * what the skill costs, and a `context_reset` result is a turn marker.
 */
export const PRUNE_EXEMPT_TOOLS: readonly string[] = [SKILL_TOOL_NAME, CONTEXT_RESET_TOOL_NAME];

/** Everything `stubFor` needs; every field is derived from the history alone. */
export interface StubAbout {
  readonly rule: PruneRule;
  /** The tool whose result (or call) this is. */
  readonly toolName?: string;
  /** The call that superseded/duplicated this result. */
  readonly supersededBy?: string;
  /** The path the stub points the model back to. */
  readonly path?: string;
  /** A read's range as the stub states it, e.g. `lines 10-14`. */
  readonly range?: string;
  /** The size being removed. */
  readonly chars?: number;
  /** R3: the kept header (an `exit=N` line or a job-status line). */
  readonly firstLine?: string;
  /** R3: the kept head and tail, already joined. */
  readonly head?: string;
  readonly tail?: string;
  /** R3: how many lines were dropped. */
  readonly omittedLines?: number;
  /** R4: where the full output lives. */
  readonly spillPath?: string;
  /** `viewed_image`: the viewed image's id (its first 12 hex are shown) and label. */
  readonly imageId?: string;
  readonly imageLabel?: string;
}

/** `12,345` → `12.3k`, for a stub's size note. */
export function formatChars(chars: number): string {
  if (chars < 1000) {
    return `${chars} chars`;
  }
  if (chars < 1_000_000) {
    return `${(chars / 1000).toFixed(1)}k chars`;
  }
  return `${(chars / 1_000_000).toFixed(1)}M chars`;
}

/**
 * The stub for one candidate: a pure function of `about`, so two computations
 * over the same history produce identical bytes (the cache stability the design
 * needs). Never reads the clock or any mutable state.
 */
export function stubFor(about: StubAbout): ChatMessage {
  const size = about.chars === undefined ? "pruned" : formatChars(about.chars);
  switch (about.rule) {
    case "superseded_read": {
      const path = about.path ?? "the file";
      const range = about.range === undefined ? "" : ` ${about.range}`;
      const by = about.supersededBy === undefined ? "" : ` (call ${about.supersededBy})`;
      return {
        role: "tool",
        content: `${PRUNE_MARKER}: fs_read ${path}${range} (${size}) — superseded by a later read or edit${by}; fs_read ${path} again for the current content⟫`,
      };
    }
    case "duplicate": {
      const tool = about.toolName ?? "a tool";
      const by = about.supersededBy === undefined ? "" : ` (call ${about.supersededBy})`;
      return {
        role: "tool",
        content: `${PRUNE_MARKER}: identical to the later result of ${tool}${by}; that one is still in the conversation⟫`,
      };
    }
    case "long_output": {
      const tool = about.toolName ?? "shell";
      const header = about.firstLine === undefined ? "" : `${about.firstLine}\n`;
      const omitted =
        about.omittedLines === undefined ? "" : `…[${about.omittedLines} lines omitted]…\n`;
      return {
        role: "tool",
        content: `${PRUNE_MARKER}: ${tool} output (${size}) — head and tail kept; re-run only if the command is safe to repeat, else read the spill file if the output named one⟫\n${header}${about.head ?? ""}${omitted}${about.tail ?? ""}`,
      };
    }
    case "spill_preview": {
      const where =
        about.spillPath === undefined
          ? "the full output is no longer available"
          : `the full output is in ${about.spillPath} — fs_read ${about.spillPath} (offset/limit) or grep it`;
      const header = about.firstLine === undefined ? "" : `${about.firstLine}\n`;
      return {
        role: "tool",
        content:
          `${PRUNE_MARKER}: ${about.toolName ?? "tool"} output (${size}) — preview dropped; ${where}⟫\n${header}`.trimEnd(),
      };
    }
    case "viewed_image": {
      // docs/feat/image-view.md D8: the stub carries NO attachments (the image
      // leaves the request); the ref text lets the model look again.
      const id12 = (about.imageId ?? "").slice(0, 12);
      const label = about.imageLabel === undefined ? "" : ` (${about.imageLabel})`;
      return {
        role: "tool",
        content: `${PRUNE_MARKER}: image_view ${id12}${label} viewed earlier — image_view ${id12} again to see it⟫`,
      };
    }
    case "call_payload":
      // R2 lives INSIDE the arguments string (a JSON value), never a message.
      return {
        role: "tool",
        content: payloadPlaceholder(size, about.path),
      };
  }
}

/**
 * The placeholder R2 puts where a payload string was, inside a call's
 * arguments: a JSON string value, never top-level, always carrying the marker.
 */
export function payloadPlaceholder(size: string, path: string | undefined): string {
  const where = path === undefined ? "" : `, already written to ${path}`;
  const back = path === undefined ? "fs_read it" : `fs_read ${path}`;
  return `${PRUNE_MARKER}: ${size}${where} — ${back} if you need the text⟫`;
}

/** A resolved read range: `to === undefined` means "to the end of the file". */
interface ReadRange {
  readonly from: number;
  readonly to: number | undefined;
}

/**
 * What one `fs_read` call covered. Text reads cover LINES; a PDF read covers
 * PAGES (`pages`, default the first 100), and a page window is not comparable
 * with a line range — `pages: "101-200"` is covered only by the same `pages`.
 */
interface ReadSpan {
  readonly range?: ReadRange;
  readonly pages?: string;
}

/** What one assistant round's call is, for the rules that look forward. */
interface CallSite {
  readonly index: number;
  readonly call: ToolCall;
  readonly path?: string;
  readonly read?: ReadSpan;
  /** The content of the result message answering it, when there is one. */
  readonly result?: string;
}

/**
 * The range `fs_read` will read: its `offset`/`limit`, or a `path:start:end`
 * suffix. The tool's own parser is `parsePathRange` (packages/tools/src/
 * builtins.ts:84); this is the same rule, kept local so S1 touches no other
 * package, and pinned by a test that reads `path:5:9` the same way.
 */
function splitPathRange(path: string): { path: string; range?: ReadRange } {
  const match = /^(.*?):(\d+)(?::(\d+))?$/.exec(path);
  if (!match?.[1]) {
    return { path };
  }
  const from = Number(match[2]);
  const end = match[3] !== undefined ? Number(match[3]) : undefined;
  return { path: match[1], range: { from, to: end } };
}

/** The range an `fs_read` call reads, or `undefined` for a whole-file read. */
function readRangeOf(args: Record<string, unknown>): ReadRange | undefined {
  const path = typeof args.path === "string" ? args.path : "";
  const fromPath = splitPathRange(path).range;
  const offset = typeof args.offset === "number" ? args.offset : undefined;
  const limit = typeof args.limit === "number" ? args.limit : undefined;
  // An explicit offset/limit wins (the tool ignores the suffix then), else the suffix.
  if (offset === undefined && limit === undefined) {
    return fromPath;
  }
  const from = Math.max(1, offset ?? 1);
  return { from, to: limit === undefined ? undefined : from + limit - 1 };
}

/**
 * The span an `fs_read` call covered. A `pages` read is a PAGE window on a PDF
 * (default the first 100): it is not a line range, so it is covered only by an
 * identical `pages` string — never by a whole-file ("first 100 pages") read,
 * which would leave the stubbed pages in neither.
 */
function readSpanOf(args: Record<string, unknown>): ReadSpan {
  const pages = typeof args.pages === "string" ? args.pages : undefined;
  if (pages !== undefined) {
    return { pages };
  }
  const range = readRangeOf(args);
  return range === undefined ? {} : { range };
}

/** A whole-file read covers every line: `{from: 1, to: undefined}`. */
const WHOLE_FILE: ReadRange = { from: 1, to: undefined };

/** Does `later` cover everything `earlier` read? `undefined` is "the whole file". */
function covers(later: ReadRange | undefined, earlier: ReadRange | undefined): boolean {
  const a = later ?? WHOLE_FILE;
  const b = earlier ?? WHOLE_FILE;
  if (a.from > b.from) {
    return false;
  }
  if (a.to === undefined) {
    return true;
  }
  return b.to !== undefined && b.to <= a.to;
}

/**
 * Does `later` cover everything the earlier read of the same path returned? A
 * page window and a line window are different spaces: each is covered only by
 * an identical counterpart.
 */
function spanCovers(later: ReadSpan, earlier: ReadSpan): boolean {
  if (later.pages !== undefined || earlier.pages !== undefined) {
    return later.pages === earlier.pages;
  }
  return covers(later.range, earlier.range);
}

/** The `lines a-b` a stub reports for a read, or undefined for a whole-file read. */
function rangeText(range: ReadRange | undefined): string | undefined {
  if (range === undefined) {
    return undefined;
  }
  return range.to === undefined ? `from line ${range.from}` : `lines ${range.from}-${range.to}`;
}

/** What a stub says a read covered: its line range, or its page window. */
function spanText(span: ReadSpan): string | undefined {
  if (span.pages !== undefined) {
    return `pages ${span.pages}`;
  }
  return rangeText(span.range);
}

/**
 * Is this call a SUCCESS? The stored history keeps no `isError` flag, so the
 * test is the tool's own success shape — a positive match, so anything else
 * (a failure, a hook rewrite, a synthesized note) is left alone. That is the
 * safe direction: pruning a result whose write did not happen would be a lie.
 */
const SUCCESS_SHAPES: Readonly<Record<string, RegExp>> = {
  fs_write: /^wrote \d+ bytes to .+ \(\+\d+ -\d+\)$/,
  fs_edit: /^edited .+ \(\+\d+ -\d+\)$/,
  fs_multi_edit: /^edited .+ with \d+ edits \(\+\d+ -\d+\)$/,
};

function succeeded(toolName: string, result: string | undefined): boolean {
  if (result === undefined) {
    return false;
  }
  const shape = SUCCESS_SHAPES[toolName];
  if (shape !== undefined) {
    return shape.test(result);
  }
  // A read has no success phrase; the only failure the registry prefixes is its
  // own, and a hook-rewritten result is not ours to judge.
  if (toolName === "fs_read") {
    return !result.startsWith("tool fs_read failed:") && !result.startsWith("[hook]");
  }
  return false;
}

/** The write tools whose arguments carry a payload R2 may replace. */
const PAYLOAD_TOOLS: ReadonlySet<string> = new Set(["fs_write", "fs_edit", "fs_multi_edit"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseObject(args: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = args.trim() === "" ? {} : JSON.parse(args);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Every payload string of an edit spec, in argument order (for the placeholder text). */
function payloadKeys(toolName: string): readonly string[] {
  if (toolName === "fs_write") {
    return ["content"];
  }
  if (toolName === "fs_edit") {
    return ["old_string", "new_string"];
  }
  return [];
}

/** R2: the arguments with every payload string replaced by a placeholder. */
function pruneArguments(
  call: ToolCall,
  path: string | undefined,
): { readonly arguments: string; readonly savedChars: number } | undefined {
  const args = parseObject(call.arguments);
  if (args === undefined) {
    return undefined;
  }
  let saved = 0;
  const shrink = (value: string): string => {
    const placeholder = payloadPlaceholder(formatChars(value.length), path);
    saved += Math.max(0, value.length - placeholder.length);
    return placeholder;
  };
  const out: Record<string, unknown> = { ...args };
  if (call.name === "fs_multi_edit") {
    const edits = Array.isArray(args.edits) ? args.edits : [];
    out.edits = edits.map((edit) => {
      if (!isRecord(edit)) {
        return edit;
      }
      const next: Record<string, unknown> = { ...edit };
      for (const key of ["old_string", "new_string"]) {
        const value = next[key];
        if (typeof value === "string") {
          next[key] = shrink(value);
        }
      }
      return next;
    });
  }
  for (const key of payloadKeys(call.name)) {
    const value = out[key];
    if (typeof value === "string") {
      out[key] = shrink(value);
    }
  }
  if (saved <= 0) {
    return undefined;
  }
  return { arguments: JSON.stringify(out), savedChars: saved };
}

/** The lines a long result keeps: its header, the first `head` and last `tail`. */
function headAndTail(
  content: string,
  head: number,
  tail: number,
): { firstLine: string; head: string; tail: string; omittedLines: number } {
  const lines = content.split("\n");
  const firstLine = lines[0] ?? "";
  const rest = lines.slice(1);
  const keptHead = rest.slice(0, head);
  const keptTail = tail > 0 ? rest.slice(Math.max(head, rest.length - tail)) : [];
  return {
    firstLine,
    head: keptHead.length > 0 ? `${keptHead.join("\n")}\n` : "",
    tail: keptTail.length > 0 ? keptTail.join("\n") : "",
    omittedLines: Math.max(0, rest.length - keptHead.length - keptTail.length),
  };
}

/**
 * The prune set for `history`: which messages the model's copy may replace, and
 * by what. Empty when nothing qualifies (then `applyPrune` returns the history
 * itself). Indices are positions in the STORED history.
 */
export function pruneCandidates(
  history: readonly ChatMessage[],
  options: PruneOptions = {},
): PruneSet {
  const keepRecentRounds = options.keepRecentRounds ?? PRUNE_DEFAULTS.keepRecentRounds;
  const outputChars = options.outputChars ?? PRUNE_DEFAULTS.outputChars;
  const headLines = options.headLines ?? PRUNE_DEFAULTS.headLines;
  const tailLines = options.tailLines ?? PRUNE_DEFAULTS.tailLines;

  // The protected tail: the last `keepRecentRounds` assistant messages and
  // everything after them (the current turn's unseen messages).
  const assistantIndices = history.flatMap((m, i) => (m.role === "assistant" ? [i] : []));
  const tailStart = assistantIndices.at(-keepRecentRounds) ?? assistantIndices[0];

  const set = new Map<number, PruneEntry>();
  if (history.length === 0) {
    return set;
  }
  const protectedFrom = tailStart === undefined ? 0 : tailStart;
  const candidates: number[] = [];
  for (let i = 0; i < protectedFrom; i++) {
    candidates.push(i);
  }

  // Every call in the history, by id, with the result that answers it — the
  // rules look both backwards (whose call is this result?) and forwards (which
  // later call supersedes it?).
  const callById = new Map<string, CallSite>();
  const sites: CallSite[] = [];
  for (let i = 0; i < history.length; i++) {
    const message = history[i];
    if (message?.role === "assistant" && message.toolCalls !== undefined) {
      for (const call of message.toolCalls) {
        const args = parseObject(call.arguments) ?? {};
        const rawPath = typeof args.path === "string" ? args.path : undefined;
        const path = rawPath === undefined ? undefined : splitPathRange(rawPath).path;
        const site: CallSite = {
          index: i,
          call,
          ...(path !== undefined ? { path } : {}),
          ...(call.name === "fs_read" ? { read: readSpanOf(args) } : {}),
        };
        sites.push(site);
        callById.set(call.id, site);
      }
    }
    if (message?.role === "tool" && message.toolCallId !== undefined) {
      const site = callById.get(message.toolCallId);
      if (site !== undefined && site.index < i) {
        // Fill the result in place, so later rules see it.
        const filled: CallSite = { ...site, result: message.content };
        sites[sites.indexOf(site)] = filled;
        callById.set(message.toolCallId, filled);
      }
    }
  }

  for (const index of candidates) {
    const message = history[index];
    if (message === undefined) {
      continue;
    }
    if (message.role === "assistant") {
      // R2: only a successful write/edit, and only its payload strings.
      const calls = message.toolCalls ?? [];
      const pruned: ToolCall[] = [];
      let saved = 0;
      let changed = false;
      for (const call of calls) {
        if (!PAYLOAD_TOOLS.has(call.name)) {
          pruned.push(call);
          continue;
        }
        const site = callById.get(call.id);
        if (site === undefined || !succeeded(call.name, site.result)) {
          pruned.push(call);
          continue;
        }
        const rewritten = pruneArguments(call, site.path);
        if (rewritten === undefined) {
          pruned.push(call);
          continue;
        }
        pruned.push({ ...call, arguments: rewritten.arguments });
        saved += rewritten.savedChars;
        changed = true;
      }
      if (changed) {
        set.set(index, {
          rule: "call_payload",
          original: message,
          message: { ...message, toolCalls: pruned },
          savedChars: saved,
        });
      }
      continue;
    }
    if (message.role !== "tool") {
      // User text (and tentacle's own notes) is never touched.
      continue;
    }
    const site = message.toolCallId === undefined ? undefined : callById.get(message.toolCallId);
    if (site === undefined || PRUNE_EXEMPT_TOOLS.includes(site.call.name)) {
      continue;
    }
    const entry = ruleFor(message, site, {
      history,
      sites,
      outputChars,
      headLines,
      tailLines,
    });
    if (entry !== undefined) {
      set.set(index, entry);
    }
  }
  return set;
}

interface ResultContext {
  readonly history: readonly ChatMessage[];
  readonly sites: readonly CallSite[];
  readonly outputChars: number;
  readonly headLines: number;
  readonly tailLines: number;
}

/** The first rule that applies to one tool result, or undefined. */
function ruleFor(message: ChatMessage, site: CallSite, ctx: ResultContext): PruneEntry | undefined {
  const toolName = site.call.name;
  const content = message.content;
  const stub = (about: StubAbout): PruneEntry => {
    const built = stubFor({ ...about, chars: content.length, toolName });
    return {
      rule: about.rule,
      original: message,
      message: { ...message, content: built.content },
      savedChars: Math.max(0, content.length - built.content.length),
    };
  };

  // R0 — an earlier `image_view`: drop its image, keep a line to look again
  // (docs/feat/image-view.md D8). Without it a stub would KEEP the ref (a
  // stub spreads every field but `content`) and the image would still be sent.
  const viewed = message.attachments?.[0];
  if (toolName === IMAGE_VIEW_TOOL_NAME && viewed !== undefined) {
    const built = stubFor({
      rule: "viewed_image",
      imageId: viewed.id,
      ...(viewed.name !== undefined ? { imageLabel: viewed.name } : {}),
    });
    const { attachments, ...rest } = message;
    return {
      rule: "viewed_image",
      original: message,
      message: { ...rest, content: built.content },
      savedChars: Math.max(0, content.length - built.content.length),
      savedImages: attachments?.length ?? 0,
    };
  }

  // R1 — an earlier read a later read or a successful write of the same path
  // superseded. Tried first: it points at the file, the truth.
  if (toolName === "fs_read" && site.path !== undefined && succeeded(toolName, content)) {
    const span = site.read ?? {};
    const superseded = ctx.sites.find((later) => {
      if (later.index <= site.index || later.path !== site.path) {
        return false;
      }
      if (later.call.name === "fs_read") {
        return succeeded("fs_read", later.result) && spanCovers(later.read ?? {}, span);
      }
      if (PAYLOAD_TOOLS.has(later.call.name)) {
        return succeeded(later.call.name, later.result);
      }
      return false;
    });
    if (superseded !== undefined) {
      const text = spanText(span);
      const entry = stub({
        rule: "superseded_read",
        supersededBy: superseded.call.id,
        ...(site.path !== undefined ? { path: site.path } : {}),
        ...(text !== undefined ? { range: text } : {}),
      });
      return entry.savedChars > 0 ? entry : undefined;
    }
  }

  // R4 — a spill whose full output is on disk: the banner is enough.
  if (message.spill?.path !== undefined) {
    const firstLine = content.split("\n")[0] ?? "";
    const entry = stub({ rule: "spill_preview", firstLine, spillPath: message.spill.path });
    if (entry.savedChars > 0) {
      return entry;
    }
  }

  // R3 — a long shell/shell_output result already acted on.
  if ((toolName === "shell" || toolName === "shell_output") && content.length > ctx.outputChars) {
    const kept = headAndTail(content, ctx.headLines, ctx.tailLines);
    const entry = stub({ rule: "long_output", ...kept });
    if (entry.savedChars > 0) {
      return entry;
    }
  }

  // R5 — byte-identical to a LATER result of the same tool with the same arguments.
  const duplicate = ctx.sites.find(
    (later) =>
      later.index > site.index &&
      later.call.name === toolName &&
      later.call.arguments === site.call.arguments &&
      later.result === content,
  );
  if (duplicate !== undefined) {
    const entry = stub({ rule: "duplicate", supersededBy: duplicate.call.id });
    if (entry.savedChars > 0) {
      return entry;
    }
  }
  return undefined;
}

/**
 * The history the model is sent: `history` with every message the set names
 * replaced by its stub. The input array and its messages are never mutated; a
 * message not in the set keeps its identity (so an anchor still matches it),
 * and an empty set returns the array itself. An entry whose index no longer
 * holds the message it was built from is SKIPPED, never applied over a
 * different one: the history may have been replaced in place under a set.
 */
export function applyPrune(history: readonly ChatMessage[], set: PruneSet): readonly ChatMessage[] {
  if (set.size === 0) {
    return history;
  }
  const out = [...history];
  let changed = false;
  for (const [index, entry] of set) {
    if (history[index] !== entry.original) {
      // A stale index (a history that shrank, or was replaced in place under a
      // set built before): ignore, the entry belongs to another conversation.
      continue;
    }
    out[index] = entry.message;
    changed = true;
  }
  return changed ? out : history;
}

/** How much of the request a set removes (characters, and the plan's token estimate). */
export interface PruneGain {
  readonly chars: number;
  readonly tokens: number;
}

/** Characters per token, as `HeuristicTokenCounter`'s default (the plan's estimate). */
const CHARS_PER_TOKEN = 4;

/** What `set` saves over `history` — the trigger's `minGainPercent` input. */
export function estimateGain(
  history: readonly ChatMessage[],
  set: PruneSet,
  options: Pick<PruneOptions, "imageTokens"> = {},
): PruneGain {
  let chars = 0;
  let images = 0;
  for (const [index, entry] of set) {
    if (history[index] !== entry.original) {
      // Stale (see `applyPrune`): it would save nothing, so it must not count.
      continue;
    }
    chars += entry.savedChars;
    images += entry.savedImages ?? 0;
  }
  // An image is not text: without its cost a viewed-image stub (~0 chars
  // saved) would never reach the trigger's minimum gain.
  const perImage = options.imageTokens ?? IMAGE_TOKEN_ESTIMATE;
  return { chars, tokens: Math.ceil(chars / CHARS_PER_TOKEN) + images * perImage };
}
