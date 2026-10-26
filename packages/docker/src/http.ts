/**
 * Pure HTTP/1.1 framing for the Engine API — no I/O, so every edge (a head
 * split across reads, chunked bodies, stream bytes riding in the same segment
 * as a `101`) is unit-testable byte by byte. `http-conn.ts` drives it over a
 * `ByteDuplex`.
 *
 * Why hand-written: `fetch` cannot do the exec hijack (a streaming request body
 * leaked the start JSON into the process's stdin, docs/eval/docker-runtime.md);
 * one framing for REST and the hijack keeps a single code path over any dialer.
 */

const encoder = new TextEncoder();
const latin1 = new TextDecoder("latin1");

/** A response head larger than this is not an engine talking: refuse it. */
export const MAX_HEAD_BYTES = 64 * 1024;
/** A chunk-size line longer than this is garbage. */
const MAX_CHUNK_LINE = 4096;

export interface HttpRequest {
  readonly method: string;
  /** Path + query, already encoded (e.g. `/v1.52/containers/x/json`). */
  readonly path: string;
  readonly headers?: Readonly<Record<string, string>>;
  /** A JSON-serialisable body (sent as `application/json`), or raw bytes. */
  readonly body?: unknown;
}

/**
 * Serialise a request. Always `Host: docker` (what the CLI sends over a unix
 * socket; the engine ignores it), an explicit `Content-Length` (0 for a
 * body-less POST/PUT — never chunked requests), and `Content-Type:
 * application/json` for a JSON body. The caller adds `Connection: close` or the
 * upgrade headers.
 */
export function buildRequest(req: HttpRequest): Uint8Array {
  let body: Uint8Array | undefined;
  let contentType: string | undefined;
  if (req.body instanceof Uint8Array) {
    body = req.body;
  } else if (req.body !== undefined) {
    body = encoder.encode(JSON.stringify(req.body));
    contentType = "application/json";
  }
  const lines = [`${req.method} ${req.path} HTTP/1.1`, "Host: docker"];
  if (contentType) {
    lines.push(`Content-Type: ${contentType}`);
  }
  if (body !== undefined || req.method === "POST" || req.method === "PUT") {
    lines.push(`Content-Length: ${body?.length ?? 0}`);
  }
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (/[\r\n]/.test(name) || /[\r\n]/.test(value)) {
      throw new Error(`invalid HTTP header ${JSON.stringify(name)}`);
    }
    lines.push(`${name}: ${value}`);
  }
  const head = encoder.encode(`${lines.join("\r\n")}\r\n\r\n`);
  if (body === undefined || body.length === 0) {
    return head;
  }
  const out = new Uint8Array(head.length + body.length);
  out.set(head);
  out.set(body, head.length);
  return out;
}

export interface ResponseHead {
  readonly status: number;
  readonly reason: string;
  /** Lower-cased header names; repeated headers joined with `, `. */
  readonly headers: ReadonlyMap<string, string>;
}

export interface HttpResponse extends ResponseHead {
  readonly body: Uint8Array;
}

export class HttpParseError extends Error {
  constructor(message: string) {
    super(`malformed response from the engine: ${message}`);
    this.name = "HttpParseError";
  }
}

export interface ResponseReaderOptions {
  /**
   * Stop after the head when this returns true (a hijack: `101`, or a
   * stream-typed `200`). The bytes after the head are then `leftover()`.
   */
  readonly headOnly?: (head: ResponseHead) => boolean;
}

function concat(parts: readonly Uint8Array[], total?: number): Uint8Array {
  const size = total ?? parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Index of `\r\n\r\n` in `bytes`, or -1. */
function headEnd(bytes: Uint8Array): number {
  for (let i = 0; i + 3 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}

function crlfAt(bytes: Uint8Array, from: number): number {
  for (let i = from; i + 1 < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10) {
      return i;
    }
  }
  return -1;
}

/** Parse the status line + headers (the bytes before `\r\n\r\n`). */
export function parseHead(text: string): ResponseHead {
  const [statusLine = "", ...headerLines] = text.split("\r\n");
  const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(statusLine);
  if (!m) {
    throw new HttpParseError(`bad status line ${JSON.stringify(statusLine.slice(0, 80))}`);
  }
  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const colon = line.indexOf(":");
    if (colon <= 0) {
      throw new HttpParseError(`bad header line ${JSON.stringify(line.slice(0, 80))}`);
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    const prev = headers.get(name);
    headers.set(name, prev === undefined ? value : `${prev}, ${value}`);
  }
  return { status: Number(m[1]), reason: m[2] ?? "", headers };
}

type BodyMode =
  | { kind: "none" }
  | { kind: "length"; remaining: number }
  | { kind: "chunked"; state: "size" | "data" | "data-crlf" | "trailer"; remaining: number }
  | { kind: "eof" };

/**
 * Incremental response reader: `push` bytes as they arrive; it returns the
 * response once complete (head + body by `Content-Length`, `chunked`, or —
 * `end()` — EOF). Bytes past the response are kept for `leftover()`.
 */
export class ResponseReader {
  private headBuf: Uint8Array = new Uint8Array(0);
  private head: ResponseHead | undefined;
  private mode: BodyMode | undefined;
  private readonly body: Uint8Array[] = [];
  private bodyBytes = 0;
  /** Unparsed chunked-framing bytes. */
  private pending: Uint8Array = new Uint8Array(0);
  private rest: Uint8Array = new Uint8Array(0);
  private done: HttpResponse | undefined;

  constructor(private readonly options: ResponseReaderOptions = {}) {}

  /** The bytes after the head (hijack) or after the body. */
  leftover(): Uint8Array {
    return this.rest;
  }

  push(bytes: Uint8Array): HttpResponse | undefined {
    if (this.done) {
      this.rest = concat([this.rest, bytes]);
      return this.done;
    }
    if (this.head === undefined) {
      const buf = concat([this.headBuf, bytes]);
      const end = headEnd(buf);
      if (end === -1) {
        if (buf.length > MAX_HEAD_BYTES) {
          throw new HttpParseError(`no end of headers within ${MAX_HEAD_BYTES / 1024} KiB`);
        }
        this.headBuf = buf;
        return undefined;
      }
      if (end > MAX_HEAD_BYTES) {
        throw new HttpParseError(`no end of headers within ${MAX_HEAD_BYTES / 1024} KiB`);
      }
      this.headBuf = new Uint8Array(0);
      const head = parseHead(latin1.decode(buf.subarray(0, end)));
      this.head = head;
      const after = buf.subarray(end + 4);
      if (this.options.headOnly?.(head)) {
        this.rest = new Uint8Array(after);
        return this.complete();
      }
      this.mode = bodyMode(head);
      return this.feed(after);
    }
    return this.feed(bytes);
  }

  /** The peer closed: completes an EOF-delimited body, else throws (truncated). */
  end(): HttpResponse {
    if (this.done) {
      return this.done;
    }
    if (this.head === undefined) {
      throw new HttpParseError(
        this.headBuf.length === 0
          ? "connection closed before a response"
          : "connection closed mid-head",
      );
    }
    if (this.mode?.kind === "eof") {
      return this.complete();
    }
    throw new HttpParseError("connection closed mid-body");
  }

  private complete(): HttpResponse {
    const head = this.head as ResponseHead;
    this.done = { ...head, body: concat(this.body, this.bodyBytes) };
    return this.done;
  }

  private take(bytes: Uint8Array): void {
    if (bytes.length > 0) {
      this.body.push(new Uint8Array(bytes));
      this.bodyBytes += bytes.length;
    }
  }

  private feed(bytes: Uint8Array): HttpResponse | undefined {
    const mode = this.mode as BodyMode;
    switch (mode.kind) {
      case "none":
        this.rest = new Uint8Array(bytes);
        return this.complete();
      case "eof":
        this.take(bytes);
        return undefined;
      case "length": {
        const n = Math.min(mode.remaining, bytes.length);
        this.take(bytes.subarray(0, n));
        mode.remaining -= n;
        if (mode.remaining === 0) {
          this.rest = new Uint8Array(bytes.subarray(n));
          return this.complete();
        }
        return undefined;
      }
      case "chunked":
        return this.feedChunked(mode, bytes);
    }
  }

  private feedChunked(
    mode: Extract<BodyMode, { kind: "chunked" }>,
    bytes: Uint8Array,
  ): HttpResponse | undefined {
    let buf = this.pending.length > 0 ? concat([this.pending, bytes]) : bytes;
    for (;;) {
      if (mode.state === "data") {
        const n = Math.min(mode.remaining, buf.length);
        this.take(buf.subarray(0, n));
        mode.remaining -= n;
        buf = buf.subarray(n);
        if (mode.remaining > 0) {
          this.pending = new Uint8Array(0);
          return undefined;
        }
        mode.state = "data-crlf";
        continue;
      }
      if (mode.state === "data-crlf") {
        if (buf.length < 2) {
          this.pending = new Uint8Array(buf);
          return undefined;
        }
        if (buf[0] !== 13 || buf[1] !== 10) {
          throw new HttpParseError("chunk not followed by CRLF");
        }
        buf = buf.subarray(2);
        mode.state = "size";
        continue;
      }
      // "size" or "trailer": a CRLF-terminated line.
      const eol = crlfAt(buf, 0);
      if (eol === -1) {
        if (buf.length > MAX_CHUNK_LINE) {
          throw new HttpParseError("chunk header too long");
        }
        this.pending = new Uint8Array(buf);
        return undefined;
      }
      const line = latin1.decode(buf.subarray(0, eol));
      buf = buf.subarray(eol + 2);
      if (mode.state === "trailer") {
        if (line === "") {
          this.pending = new Uint8Array(0);
          this.rest = new Uint8Array(buf);
          return this.complete();
        }
        continue; // a trailer header: ignored
      }
      const sizeText = (line.split(";")[0] ?? "").trim();
      if (!/^[0-9a-fA-F]+$/.test(sizeText)) {
        throw new HttpParseError(`bad chunk size ${JSON.stringify(line.slice(0, 40))}`);
      }
      const size = Number.parseInt(sizeText, 16);
      if (size === 0) {
        mode.state = "trailer";
      } else {
        mode.state = "data";
        mode.remaining = size;
      }
    }
  }
}

function bodyMode(head: ResponseHead): BodyMode {
  if ((head.status >= 100 && head.status < 200) || head.status === 204 || head.status === 304) {
    return { kind: "none" };
  }
  const te = head.headers.get("transfer-encoding");
  if (te !== undefined && /(^|,)\s*chunked\s*$/i.test(te)) {
    return { kind: "chunked", state: "size", remaining: 0 };
  }
  const cl = head.headers.get("content-length");
  if (cl !== undefined) {
    if (!/^\d+$/.test(cl)) {
      throw new HttpParseError(`bad Content-Length ${JSON.stringify(cl)}`);
    }
    const n = Number(cl);
    return n === 0 ? { kind: "none" } : { kind: "length", remaining: n };
  }
  return { kind: "eof" };
}
