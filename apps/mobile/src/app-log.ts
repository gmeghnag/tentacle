/**
 * The app's log: structured, REDACTED BEFORE AN ENTRY EXISTS (docs/feat/mobile-lock.md
 * D7; mobile decision 19).
 *
 * Settings → Export logs hands a person a text file they may share, so the file
 * must be safe to share. The repository's privacy decision (Owner Q8) is what
 * this module enforces at WRITE time, not at export time — a secret that never
 * reaches the ring cannot leak from it later:
 *
 * - a URL is reduced to `scheme://host:port`: **no userinfo, no path, no query,
 *   no fragment**. That is P3's hazard: `ws-channel.ts` puts the token in the
 *   query (`?token=…`) whenever a header is impossible, which is exactly the iOS
 *   case, so any URL that reaches a log line is a key leak unless its query goes.
 * - `Bearer …` and `token=…` are removed.
 * - any run of ≥ 20 base64 / base64url / hex characters becomes `[redacted]`
 *   (a device key, a pinned computer key, a pairing payload).
 * - a field is capped (`FIELD_MAX`), and there is NO free-text field at all: a
 *   failure is logged as its error CLASS and its numeric code (`errorShape`),
 *   never its message (F16, review round 1 finding 2).
 * - never logged at all: titles, prompts, transcript text, computer and device
 *   names, paths. Session ids only as their first 8 characters.
 *
 * Daemon text is untrusted (P4): a ws close `reason` and a client error
 * `message` are precisely the prose that can carry a title, a prompt fragment or
 * a path, so **neither reaches the ring** — the call sites log the close code and
 * the error class instead (`connection.ts`). `redact()` stays for the values a
 * caller does pass (`fieldValue`), so a secret that slips into a short field is
 * still scrubbed before the entry exists. Pure and React-free (AGENTS §7):
 * storage and the file system are injected, and the clock with them.
 */

/** The closed set of what an entry may be about (D7). No free-text kind. */
export type AppLogKind =
  | "ws-open"
  | "ws-close"
  | "ws-error"
  | "link-status"
  | "dial"
  | "gate-suspend"
  | "gate-resume"
  | "client-error"
  | "lock"
  | "unlock"
  | "auth-fail"
  | "app-state"
  | "timing";

/** What a field may hold: a number, a boolean, or a short enum/id-shaped string. */
export type AppLogField = number | boolean | string;

/** One entry. `t` is epoch ms; `fields` is already safe (see `redact`). */
export interface AppLogEntry {
  readonly t: number;
  readonly level: "info" | "warn" | "error";
  readonly kind: AppLogKind;
  readonly fields: Readonly<Record<string, AppLogField>>;
}

/** How long a free-text field may be after redaction (D7). */
export const DETAIL_MAX = 160;

/** Characters that look like a key, a payload or a signature (base64 / base64url / hex). */
const LONG_RUN = /[A-Za-z0-9+/_-]{20,}/g;
/** The same test without the `g` flag: a global regex is stateful (`lastIndex`). */
const HAS_LONG_RUN = /[A-Za-z0-9+/_-]{20,}/;

/** `scheme://user:pass@host:port/path?query#frag` → `scheme://host:port`. */
const URL_PATTERN = /\b([a-zA-Z][a-zA-Z0-9+.-]*):\/\/[^\s"'<>]*/g;

/** `Bearer <anything>`: an Authorization header echoed into a message. */
const BEARER = /\bBearer\s+[^\s"',;]+/gi;

/** `token=…`, `key=…`, `secret=…`, `sig=…`: a query or a form body inline in text. */
const SECRET_PARAM = /\b(token|key|secret|sig|signature|password|pass)=[^\s&"',;]+/gi;

/**
 * A URL reduced to `scheme://host:port`. A URL that does not parse is reduced to
 * `scheme://[redacted]` — never echoed, because the part that failed to parse is
 * the part that may carry the query.
 */
function shortenUrl(match: string): string {
  try {
    const url = new URL(match);
    const port = url.port === "" ? "" : `:${url.port}`;
    return `${url.protocol}//${url.hostname}${port}`;
  } catch {
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\//.exec(match);
    return scheme === null ? "[redacted]" : `${scheme[1]}://[redacted]`;
  }
}

/**
 * Redact free text. This is the ONE function that decides what a shared log may
 * contain, so it is applied to every `detail` BEFORE the entry exists.
 *
 * Order matters: URLs first (their query is the token), then bearer/params, then
 * long runs (which would otherwise eat a hostname that is legitimately kept),
 * then the length cap.
 */
export function redact(text: string): string {
  const shortened = text.replace(URL_PATTERN, shortenUrl);
  const bearerless = shortened.replace(BEARER, "Bearer [redacted]");
  const paramless = bearerless.replace(SECRET_PARAM, "$1=[redacted]");
  const runless = paramless.replace(LONG_RUN, "[redacted]");
  return runless.length > DETAIL_MAX ? `${runless.slice(0, DETAIL_MAX - 1)}…` : runless;
}

/** An id as the export may name it: the first 8 characters (Owner Q8). */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** The longest a `fields` string may be (D7: "short enums" — never prose). */
export const FIELD_MAX = 24;

/**
 * A value for `fields`. Numbers and booleans pass. A string is kept only when it
 * is SHORT and key-shaped (a status word, an enum); anything longer is a
 * mistake at the call site, so it is redacted and truncated to `FIELD_MAX`
 * rather than trusted — that is what makes "never a title in `fields`" a
 * property of this module instead of a promise every caller must keep.
 */
export function fieldValue(value: AppLogField): AppLogField {
  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (value.length <= FIELD_MAX && !HAS_LONG_RUN.test(value)) {
    return value;
  }
  const clean = redact(value);
  return clean.length <= FIELD_MAX ? clean : `${clean.slice(0, FIELD_MAX - 1)}…`;
}

export interface AppLogDeps {
  readonly now: () => number;
  /** How many entries the ring keeps (Owner Q7: bounded; the file adds the cap). */
  readonly capacity: number;
}

/** An error class name the log may carry: an identifier, at most `FIELD_MAX`. */
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9]{0,23}$/;

/** What a shared log may say about a failure: the CLASS, and a numeric code. */
export interface ErrorShape {
  readonly error: string;
  readonly code?: number;
}

/**
 * Classify a failure for the log: its error CLASS (and its numeric `code`, for an
 * `RpcError`), and **never its message** (F16, review round 1 finding 2).
 *
 * A message is where daemon text lands: `RemoteClient.onError` carries endpoint
 * bodies and frames, and an unknown mandatory update is even named by the
 * DAEMON's own `type` string — so a pod can put a title, a prompt fragment or a
 * path into it, and `redact()` cannot tell that prose from prose. The class is
 * ours (`new Error` → `"Error"`, `RpcError` → `"RpcError"`) and the code is a
 * number, so both are safe and the text stays out of the file altogether. A
 * name that is not identifier-shaped (nothing in the repo builds one, but a
 * non-`Error` throw is untrusted by definition) becomes `"Error"`.
 */
export function errorShape(error: unknown): ErrorShape {
  const raw = error instanceof Error ? error.name : "";
  const name = ERROR_NAME.test(raw) ? raw : "Error";
  const code = (error as { readonly code?: unknown } | null | undefined)?.code;
  return typeof code === "number" && Number.isFinite(code)
    ? { error: name, code }
    : { error: name };
}

/** A read-only view for export: entries in the order they were logged. */
export interface AppLog {
  /**
   * One entry. Every field is a number, a boolean or a short enum-shaped string
   * (`fieldValue`), and there is **no free-text field at all** — so a caller
   * cannot pass daemon text even by mistake (F16; review round 1, finding 2).
   */
  log(
    level: AppLogEntry["level"],
    kind: AppLogKind,
    fields?: Readonly<Record<string, AppLogField>>,
  ): AppLogEntry;
  /** `redact()`, for a caller that has text and wants it scrubbed once (unused today). */
  readonly redact: typeof redact;
  /** The entries the ring still holds, oldest first. */
  entries(): readonly AppLogEntry[];
  /** Drop everything (the export's own "clear" is not needed: never offered). */
  clear(): void;
  /** How many entries were DROPPED because the ring was full (a fact for the export). */
  dropped(): number;
}

/**
 * The bounded ring. Oldest entries fall off the front, so a long session keeps
 * its most recent history — the "it failed a minute ago" case, which is why the
 * ring is not memory-only-from-launch (Owner Q7).
 */
export function createAppLog(deps: AppLogDeps): AppLog {
  const ring: AppLogEntry[] = [];
  let dropped = 0;
  const capacity = Math.max(1, deps.capacity);
  return {
    log(level, kind, fields) {
      const clean: Record<string, AppLogField> = {};
      for (const [key, value] of Object.entries(fields ?? {})) {
        clean[key] = fieldValue(value);
      }
      const entry: AppLogEntry = { t: deps.now(), level, kind, fields: clean };
      ring.push(entry);
      while (ring.length > capacity) {
        ring.shift();
        dropped += 1;
      }
      return entry;
    },
    redact,
    entries: () => [...ring],
    clear() {
      ring.length = 0;
    },
    dropped: () => dropped,
  };
}

/** The entries as the export's text: one line each, `ISO time level kind k=v …`. */
export function entriesToText(entries: readonly AppLogEntry[]): string {
  return entries
    .map((entry) => {
      const time = new Date(entry.t).toISOString();
      const fields = Object.entries(entry.fields)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");
      return `${time} ${entry.level} ${entry.kind}${fields === "" ? "" : ` ${fields}`}`;
    })
    .join("\n");
}

/** What the export says about this app and device (D7): no names, no paths. */
export interface ExportHeader {
  readonly appVersion: string;
  readonly build: string;
  readonly osVersion: string;
  readonly deviceModel: string;
  readonly exportedAt: number;
  /** Entries the ring had dropped by the time of the export (honest, not silent). */
  readonly droppedEntries: number;
}

/**
 * The export file's text: a header block, then the entries. Header fields are
 * app/OS facts only — the version, the build, `iOS <version>`, the device
 * MODEL (e.g. `iPhone17,1`, not the person's device name; Owner Q8).
 */
export function exportText(header: ExportHeader, entries: readonly AppLogEntry[]): string {
  const lines = [
    "tentacle app log",
    `app: ${header.appVersion} (build ${header.build})`,
    `os: iOS ${header.osVersion}`,
    `device: ${header.deviceModel}`,
    `exported: ${new Date(header.exportedAt).toISOString()}`,
    `entries: ${entries.length}`,
    ...(header.droppedEntries > 0 ? [`dropped: ${header.droppedEntries} (ring bound)`] : []),
    "",
  ];
  const body = entriesToText(entries);
  return `${lines.join("\n")}${body === "" ? "" : `${body}\n`}`;
}

/** The export file's name: a UTC stamp, no device or computer name (Owner Q8). */
export function exportFileName(at: number): string {
  // `2026-11-14T07-19-00Z`: ISO 8601 with the colons replaced (a colon is legal
  // on iOS but shows up escaped in the share sheet's own suggestions).
  return `tentacle-logs-${new Date(at).toISOString().replace(/[:.]/g, "-")}.txt`;
}
