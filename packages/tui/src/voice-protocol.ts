/**
 * The helper's wire protocol, v1 (docs/feat/voice-dictation.md §3): ONE JSON
 * object per line, in both directions, over the child's stdin/stdout.
 *
 * Pure: no spawn, no I/O, no React — `useVoice.ts` owns the pipes and this
 * module owns what a line MEANS. Everything here is total: a malformed line, an
 * unknown type, a missing field, an oversized frame and a version skew are all
 * `{ ok: false }` VALUES, never a throw, because a buggy or hostile helper must
 * degrade to a notice and not to a crashed TUI (F2/F3/F4).
 *
 * The version is decided ONCE, on the `ready` line: a helper that announces a
 * different `v` is refused and killed, so there is no half-working pairing. A
 * later line may not carry a `v` at all.
 */

/** The protocol version this TUI speaks; a helper's `ready.v` must equal it. */
export const VOICE_PROTOCOL_VERSION = 1;

/**
 * The longest accepted line, in UTF-8 bytes. A `final` carries a transcript of
 * minutes of speech, so the cap is generous; past it the frame is a protocol
 * error rather than something to buffer without bound.
 */
export const MAX_LINE_BYTES = 64 * 1024;

/** The error codes the helper may send (an unknown one is kept, not refused). */
export type VoiceErrorCode =
  | "mic_denied"
  | "no_input"
  | "models_missing"
  | "model_load_failed"
  | "stt_failed"
  | "route_lost"
  | "bad_request";

/** What the TUI sends. */
export type HelperCommand =
  | { readonly t: "start"; readonly id: number; readonly lang: "auto" | "it" | "en" }
  | { readonly t: "turn"; readonly id: number }
  | { readonly t: "stop"; readonly id: number }
  | { readonly t: "cancel"; readonly id: number };

/** What the helper sends back. */
export type HelperMessage =
  | { readonly t: "ready"; readonly v: number; readonly engine: string; readonly device: string }
  | { readonly t: "listening"; readonly id: number; readonly device: string }
  | { readonly t: "vad"; readonly id: number; readonly ms: number; readonly p: number }
  | { readonly t: "level"; readonly id: number; readonly dbfs: number }
  | { readonly t: "turnp"; readonly id: number; readonly p: number }
  | { readonly t: "partial"; readonly id: number; readonly text: string }
  | {
      readonly t: "final";
      readonly id: number;
      readonly text: string;
      readonly lang?: string;
      readonly audioMs?: number;
      readonly sttMs?: number;
    }
  | {
      readonly t: "error";
      readonly id?: number;
      readonly code: string;
      readonly message: string;
    };

/** A protocol error, as a value (never a thrown exception). */
export interface VoiceProtocolError {
  readonly code: "bad_request" | "line_too_long" | "version_mismatch";
  readonly message: string;
}

/** The result of reading one line off the helper's stdout. */
export type ParsedLine =
  | { readonly ok: true; readonly message: HelperMessage }
  | { readonly ok: false; readonly error: VoiceProtocolError };

/** The result of reading one line the TUI sent (the helper's side). */
export type ParsedCommand =
  | { readonly ok: true; readonly message: HelperCommand }
  | { readonly ok: false; readonly error: VoiceProtocolError };

// --- building the lines the TUI sends (typed, so a typo cannot reach the wire)

export function startCommand(id: number, lang: "auto" | "it" | "en"): HelperCommand {
  return { t: "start", id, lang };
}

export function stopCommand(id: number): HelperCommand {
  return { t: "stop", id };
}

export function cancelCommand(id: number): HelperCommand {
  return { t: "cancel", id };
}

export function turnCommand(id: number): HelperCommand {
  return { t: "turn", id };
}

// --- the fixtures/helpers the tests and the fake helper build messages with

export function helperReady(fields: {
  v?: number;
  engine?: string;
  device?: string;
}): HelperMessage {
  return {
    t: "ready",
    v: fields.v ?? VOICE_PROTOCOL_VERSION,
    engine: fields.engine ?? "apple",
    device: fields.device ?? "",
  };
}

export function helperFinal(fields: {
  id: number;
  text: string;
  lang?: string;
  audioMs?: number;
  sttMs?: number;
}): HelperMessage {
  return {
    t: "final",
    id: fields.id,
    text: fields.text,
    ...(fields.lang === undefined ? {} : { lang: fields.lang }),
    ...(fields.audioMs === undefined ? {} : { audioMs: fields.audioMs }),
    ...(fields.sttMs === undefined ? {} : { sttMs: fields.sttMs }),
  };
}

export function helperError(fields: {
  id?: number;
  code: VoiceErrorCode | string;
  message: string;
}): HelperMessage {
  return {
    t: "error",
    ...(fields.id === undefined ? {} : { id: fields.id }),
    code: fields.code,
    message: fields.message,
  };
}

/**
 * One message as one wire line, newline included. `JSON.stringify` escapes an
 * embedded newline, so a transcript can never break the framing.
 */
export function encodeHelperLine(message: HelperCommand | HelperMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/**
 * Decode one COMPLETE line (without its newline is fine). Returns `null` for a
 * blank line — a kept-alive or a stray newline, which is not an error.
 */
export function parseHelperLine(line: string): ParsedLine | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  if (Buffer.byteLength(trimmed, "utf8") > MAX_LINE_BYTES) {
    return {
      ok: false,
      error: {
        code: "line_too_long",
        message: `helper line is over ${String(MAX_LINE_BYTES)} bytes`,
      },
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: { code: "bad_request", message: "helper line is not JSON" } };
  }
  return decodeHelperValue(raw);
}

/** Decode an already-parsed value (the same checks, for a test or a fake). */
export function decodeHelperLine(line: string): HelperMessage | null {
  const parsed = parseHelperLine(line);
  return parsed?.ok ? parsed.message : null;
}

/**
 * Decode one line the TUI SENT — the other direction. The pipe is symmetric, so
 * this is what a fake helper (a test) and the Swift helper's own decoder read.
 */
export function parseCommandLine(line: string): ParsedCommand | null {
  const trimmed = line.trim();
  if (trimmed === "") return null;
  if (Buffer.byteLength(trimmed, "utf8") > MAX_LINE_BYTES) {
    return {
      ok: false,
      error: {
        code: "line_too_long",
        message: `command line is over ${String(MAX_LINE_BYTES)} bytes`,
      },
    };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return { ok: false, error: { code: "bad_request", message: "command line is not JSON" } };
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return commandBad("command line is not a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const id = num(o, "id");
  if (id === undefined) return commandBad("command without an id");
  const t = o.t;
  if (t === "start") {
    const lang = o.lang;
    if (lang !== "auto" && lang !== "it" && lang !== "en")
      return commandBad("start without a language");
    return { ok: true, message: { t: "start", id, lang } };
  }
  if (t === "turn" || t === "stop" || t === "cancel") return { ok: true, message: { t, id } };
  return commandBad(`unknown command type ${JSON.stringify(String(t))}`);
}

function bad(message: string): ParsedLine {
  return { ok: false, error: { code: "bad_request", message } };
}

function commandBad(message: string): ParsedCommand {
  return { ok: false, error: { code: "bad_request", message } };
}

function num(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

function str(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === "string" ? v : undefined;
}

/**
 * The ONE shape check. Each arm names the fields it needs and nothing more:
 * unknown fields are dropped (a newer helper may add some — forward compat),
 * which is why this is a hand-written switch and not a stricter schema.
 */
function decodeHelperValue(raw: unknown): ParsedLine {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return bad("helper line is not a JSON object");
  }
  const o = raw as Record<string, unknown>;
  const t = o.t;

  // The handshake: the ONLY line that may carry a version.
  if (t === "ready") {
    const v = num(o, "v");
    if (v === undefined) return bad("ready without a version");
    if (v !== VOICE_PROTOCOL_VERSION) {
      return {
        ok: false,
        error: {
          code: "version_mismatch",
          message: `voice helper speaks protocol ${String(v)}, this TUI speaks ${String(VOICE_PROTOCOL_VERSION)}`,
        },
      };
    }
    return {
      ok: true,
      message: { t: "ready", v, engine: str(o, "engine") ?? "", device: str(o, "device") ?? "" },
    };
  }

  // Any other line claiming a version is a half-working pair: refuse it.
  if (o.v !== undefined) return bad("only a `ready` line may carry a version");

  if (t === "listening") {
    const id = num(o, "id");
    if (id === undefined) return bad("listening without an id");
    return { ok: true, message: { t: "listening", id, device: str(o, "device") ?? "" } };
  }
  if (t === "vad") {
    const id = num(o, "id");
    const ms = num(o, "ms");
    const p = num(o, "p");
    if (id === undefined || ms === undefined || p === undefined) return bad("incomplete vad");
    return { ok: true, message: { t: "vad", id, ms, p } };
  }
  if (t === "level") {
    const id = num(o, "id");
    const dbfs = num(o, "dbfs");
    if (id === undefined || dbfs === undefined) return bad("incomplete level");
    return { ok: true, message: { t: "level", id, dbfs } };
  }
  if (t === "turnp") {
    const id = num(o, "id");
    const p = num(o, "p");
    if (id === undefined || p === undefined) return bad("incomplete turnp");
    return { ok: true, message: { t: "turnp", id, p } };
  }
  if (t === "partial") {
    const id = num(o, "id");
    const text = str(o, "text");
    if (id === undefined || text === undefined) return bad("incomplete partial");
    return { ok: true, message: { t: "partial", id, text } };
  }
  if (t === "final") {
    const id = num(o, "id");
    const text = str(o, "text");
    if (id === undefined || text === undefined) return bad("incomplete final");
    const lang = str(o, "lang");
    const audioMs = num(o, "audioMs");
    const sttMs = num(o, "sttMs");
    return {
      ok: true,
      message: {
        t: "final",
        id,
        text,
        ...(lang === undefined ? {} : { lang }),
        ...(audioMs === undefined ? {} : { audioMs }),
        ...(sttMs === undefined ? {} : { sttMs }),
      },
    };
  }
  if (t === "error") {
    const code = str(o, "code");
    if (code === undefined) return bad("error without a code");
    const id = num(o, "id");
    return {
      ok: true,
      message: {
        t: "error",
        ...(id === undefined ? {} : { id }),
        code,
        message: str(o, "message") ?? "",
      },
    };
  }
  return bad(`unknown helper message type ${JSON.stringify(String(t))}`);
}
