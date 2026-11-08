/**
 * The laptop's side of `session/log` (docs/feat/session-log.md): validate the
 * pages a daemon returned, project them onto the history this client holds,
 * and classify the read against it. Pure: no I/O, no clock.
 *
 * A pod is not trusted (AGENTS §7, F4): every entry of a KNOWN type is parsed
 * by its own schema and only that re-serialized value is kept; an UNKNOWN type
 * is dropped when not `critical` and refuses the whole read when it is (this
 * build cannot project without it). Any violation — a broken chain, an
 * out-of-range `replace`/`truncate`, a `base` not followed by its messages —
 * refuses the read: nothing is applied, the held state is untouched.
 *
 * Lineage (F1): a read that does not continue the held head linearly is
 * classified. Same incarnation → one writer, linear by construction (a `gap`
 * when it was rebased). A `base` linked to the held head → a reseed from this
 * very copy. Otherwise a NEW lineage: equal to, or an extension of, the held
 * projection → adopted; anything else is a FORK — the held copy is returned
 * as `aside` (set aside by the caller, never spliced) and the daemon's adopted
 * (the daemon owns the live conversation; owner decision Q3).
 */
import type { ChatMessage } from "@tentacle/core";
import {
  type KnownLogEntry,
  KnownLogEntrySchema,
  LOG_ENTRY_CRITICAL,
  type LogCursor,
  type LogEntryEnvelope,
  type LogResult,
  type SessionTitle,
  type Sha256,
  digestOfDigests,
  messageDigest,
  projectEntry,
} from "@tentacle/protocol";

/** What a client holds of a session's log: its head, the projection, and each message's digest. */
export interface LogState {
  /** The incarnation of the last `base` applied. */
  readonly inc: string;
  readonly head: LogCursor;
  readonly messages: readonly ChatMessage[];
  readonly digests: readonly string[];
}

export type LogOutcome =
  /** No held state: the daemon's projection, as read. */
  | "cold"
  /** The entries continue the held head. */
  | "linear"
  /** Rebased within the same incarnation (one writer): adopted, `gap` set. */
  | "rebased"
  /** A new incarnation reseeded from the held head (`base.prev` = head). */
  | "reseed"
  /** A new lineage equal to, or extending, the held projection. */
  | "adopt"
  /** A new lineage that is neither: the held copy is `aside`. */
  | "fork";

export interface LogApplied {
  readonly state: LogState;
  readonly outcome: LogOutcome;
  /** The validated known entries of this read, re-serialized (what task 2 appends to disk). */
  readonly entries: readonly KnownLogEntry[];
  /** The newest `title` entry of this read. */
  readonly title?: SessionTitle;
  /** The held projection, on a fork: the caller sets it aside. */
  readonly aside?: readonly ChatMessage[];
  /** Entries between the held head and the `base` were not available (rebased). */
  readonly gap?: true;
  /** A `checkpoint` disagreed with the projection (F2: derivation drift). */
  readonly drift?: { readonly seq: number };
}

export type LogReadError = { readonly error: string };

const KNOWN: ReadonlySet<string> = new Set(Object.keys(LOG_ENTRY_CRITICAL));

/**
 * Apply `pages` (one read, in order) to `held`. Only the first page may be
 * `rebased` (a later one means the log moved under the read: restart it).
 */
export function applyLogRead(
  held: LogState | null,
  pages: readonly LogResult[],
  sha256: Sha256,
): LogApplied | LogReadError {
  if (pages.length === 0) {
    return { error: "no page" };
  }
  if (pages.slice(1).some((p) => p.rebased === true)) {
    return { error: "the log was rebased between two pages" };
  }
  const last = pages[pages.length - 1];
  if (last === undefined || last.more) {
    return { error: "the read is incomplete" };
  }
  const raw = pages.flatMap((p) => p.entries);
  const rebased = pages[0]?.rebased === true;

  // The chain over EVERY entry (unknown ones occupy a seq too).
  const first = raw[0];
  if (first === undefined) {
    if (held === null) {
      return { error: "an empty log" };
    }
    if (rebased || last.tip.seq !== held.head.seq || last.tip.id !== held.head.id) {
      return { error: "no entries, yet the log's tip is not the held head" };
    }
    return { state: held, outcome: "linear", entries: [] };
  }
  // A read continues the held head, or (cold, rebased) starts at a base.
  const linear =
    held !== null && !rebased && first.prev === held.head.id && first.seq === held.head.seq + 1;
  if (held !== null && !rebased && !linear && first.type !== "base") {
    return { error: `entry ${first.seq} does not follow the held head ${held.head.seq}` };
  }
  const fromBase = !linear;
  for (let i = 1; i < raw.length; i++) {
    const [a, b] = [raw[i - 1], raw[i]];
    if (a === undefined || b === undefined || b.seq !== a.seq + 1 || b.prev !== a.id) {
      return { error: `entry ${b?.seq ?? "?"} breaks the chain` };
    }
  }
  const tail = raw[raw.length - 1];
  if (tail === undefined || last.tip.seq !== tail.seq || last.tip.id !== tail.id) {
    return { error: "the log's tip is not its last entry" };
  }

  // Parse: known → its own schema (re-serialized); unknown → dropped or refused.
  const entries: KnownLogEntry[] = [];
  for (const envelope of raw) {
    const parsed = parseEntry(envelope);
    if ("error" in parsed) return parsed;
    if (parsed.entry !== null) entries.push(parsed.entry);
  }
  const head0 = entries[0];
  if (fromBase && head0?.type !== "base") {
    return { error: "a read from a base does not start with one" };
  }

  // Project.
  const messages: ChatMessage[] = linear && held !== null ? [...held.messages] : [];
  const digests: string[] = linear && held !== null ? [...held.digests] : [];
  let inc = held?.inc ?? "";
  let firstBase: Extract<KnownLogEntry, { type: "base" }> | undefined;
  /**
   * The digests of the first base's `count` seed messages, taken the moment its
   * `expect` reaches 0: commits after the seed (appends, replaces such as a head
   * swap) are not part of the lineage check (M2).
   */
  let seed: string[] | undefined;
  let expect = 0; // message entries a base still owes
  let title: SessionTitle | undefined;
  let drift: { seq: number } | undefined;
  for (const e of entries) {
    if (expect > 0 && e.type !== "message") {
      return { error: `base owes ${expect} messages, got ${e.type}` };
    }
    // The shared fold (the disk log applies the same step), on both lists.
    const problem =
      projectEntry(messages, e, (m) => m as ChatMessage) ??
      projectEntry(digests, e, (m) => messageDigest(m, sha256));
    if (problem !== null) {
      return { error: problem };
    }
    switch (e.type) {
      case "base":
        firstBase ??= e;
        inc = e.inc;
        expect = e.count;
        if (e === firstBase && expect === 0) seed = [];
        break;
      case "message":
        if (expect > 0 && --expect === 0 && seed === undefined && firstBase !== undefined) {
          seed = [...digests];
        }
        break;
      case "checkpoint":
        if (
          drift === undefined &&
          (e.count !== messages.length || e.digest !== digestOfDigests(digests, sha256))
        ) {
          drift = { seq: e.seq };
        }
        break;
      case "title":
        title = e.title;
        break;
      default:
        break; // `replace`/`truncate` (projected above) and the turn markers
    }
  }
  if (expect > 0) {
    return { error: `the log ends ${expect} messages short of its base` };
  }
  const state: LogState = { inc, head: { seq: tail.seq, id: tail.id }, messages, digests };

  // Classify.
  let outcome: LogOutcome;
  let aside: readonly ChatMessage[] | undefined;
  let gap = false;
  if (held === null) {
    outcome = "cold";
  } else if (!fromBase) {
    outcome = "linear";
  } else if (firstBase !== undefined && firstBase.inc === held.inc) {
    outcome = "rebased";
    gap = rebased;
  } else if (firstBase?.prev !== undefined && firstBase.prev === held.head.id) {
    // A reseed from THIS head carries exactly this copy as its seed (an honest
    // one always does; later commits are not the seed). A seed that does not is
    // a forged or confused claim: a fork, set aside (L1, M2).
    if (seed !== undefined && sameDigests(held.digests, seed)) {
      outcome = "reseed";
    } else {
      outcome = "fork";
      aside = held.messages;
    }
  } else if (pages[0]?.root?.id === held.head.id && pages[0]?.root?.seq === held.head.seq) {
    // The incarnation was reseeded from this head, but its seed segment is not
    // retained any more (compactions since): a true gap, not a fork (M1).
    outcome = "reseed";
    gap = true;
  } else if (extends_(held.digests, digests)) {
    outcome = "adopt";
  } else {
    outcome = "fork";
    aside = held.messages;
  }
  return {
    state,
    outcome,
    entries,
    ...(title ? { title } : {}),
    ...(aside ? { aside } : {}),
    ...(gap ? { gap: true as const } : {}),
    ...(drift ? { drift } : {}),
  };
}

/** Equal digest lists. */
function sameDigests(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((d, i) => b[i] === d);
}

/** `next` equals `held` or extends it (by per-message digests). */
function extends_(held: readonly string[], next: readonly string[]): boolean {
  return next.length >= held.length && held.every((d, i) => next[i] === d);
}

function parseEntry(
  envelope: LogEntryEnvelope,
): { readonly entry: KnownLogEntry | null } | LogReadError {
  if (!KNOWN.has(envelope.type)) {
    return envelope.critical === true
      ? {
          error: `the daemon's log has a critical entry of a type this build does not know (${envelope.type}): update tentacle`,
        }
      : { entry: null };
  }
  const parsed = KnownLogEntrySchema.safeParse(envelope);
  if (!parsed.success) {
    return { error: `malformed ${envelope.type} entry ${envelope.seq}` };
  }
  return { entry: parsed.data };
}
