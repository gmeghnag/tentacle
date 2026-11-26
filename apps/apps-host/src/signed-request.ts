/**
 * Publisher authentication: an Ed25519-signed request with a date and a nonce
 * (docs/feat/session-apps-host.md D2/D3). Two stages, so the server can refuse on
 * the headers alone before it reads a body: `checkSignedHeaders` (shape, clock),
 * then `verifySignedBody` (hash, signature, nonce).
 */
import {
  APPS_HEADERS,
  APPS_KEY_BYTES,
  APPS_NONCE_BYTES,
  APPS_SIGNATURE_BYTES,
  type AppsErrorCode,
  appsSigningPayload,
  decodeBase64Url,
} from "@tentacle/protocol";

export type Refusal = {
  readonly ok: false;
  readonly error: AppsErrorCode;
  readonly message: string;
  readonly serverTime?: number;
};

/** What is read of a request's headers (structural: Bun's and Node's types differ). */
export interface HeaderReader {
  get(name: string): string | null;
}

export interface SignedHeaders {
  /** The public key's header text: the publisher's identity. */
  readonly key: string;
  readonly keyBytes: Uint8Array;
  /** The date header's own text (it is what was signed). */
  readonly date: string;
  readonly dateMs: number;
  readonly nonce: string;
  readonly signature: Uint8Array;
}

const refuse = (error: AppsErrorCode, message: string): Refusal => ({
  ok: false,
  error,
  message,
});

/** A canonical base64url value of exactly `bytes` bytes. */
function binary(value: string | null, bytes: number): Uint8Array | undefined {
  const length = Math.ceil((bytes * 4) / 3);
  if (value === null || value.length !== length) {
    return undefined;
  }
  const decoded = decodeBase64Url(value);
  return decoded?.length === bytes ? decoded : undefined;
}

export function checkSignedHeaders(
  headers: HeaderReader,
  clock: { readonly now: number; readonly startedAt: number; readonly skewMs: number },
): { readonly ok: true; readonly request: SignedHeaders } | Refusal {
  const key = headers.get(APPS_HEADERS.key);
  const date = headers.get(APPS_HEADERS.date);
  const nonce = headers.get(APPS_HEADERS.nonce);
  const keyBytes = binary(key, APPS_KEY_BYTES);
  const signature = binary(headers.get(APPS_HEADERS.signature), APPS_SIGNATURE_BYTES);
  if (
    key === null ||
    keyBytes === undefined ||
    signature === undefined ||
    nonce === null ||
    binary(nonce, APPS_NONCE_BYTES) === undefined ||
    date === null ||
    !/^[1-9][0-9]{0,15}$/.test(date) ||
    !Number.isSafeInteger(Number(date))
  ) {
    return refuse("bad_request", "missing or malformed signature headers");
  }
  const dateMs = Number(date);
  if (Math.abs(clock.now - dateMs) > clock.skewMs) {
    return {
      ...refuse("clock_skew", "the request date is too far from the host's clock"),
      serverTime: clock.now,
    };
  }
  // The nonce cache is memory-only: whatever was signed before this process
  // started may already have been used.
  if (dateMs < clock.startedAt) {
    return refuse("replay", "the request was signed before the host started");
  }
  return { ok: true, request: { key, keyBytes, date, dateMs, nonce, signature } };
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function verifies(request: SignedHeaders, payload: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", request.keyBytes, { name: "Ed25519" }, false, [
      "verify",
    ]);
    return await crypto.subtle.verify(
      "Ed25519",
      key,
      request.signature,
      new TextEncoder().encode(payload),
    );
  } catch {
    // 32 bytes that are not a curve point: nobody's key.
    return false;
  }
}

/**
 * The nonces of verified requests, remembered for as long as their date would
 * still be accepted. Full = refuse: evicting an in-window nonce would reopen
 * replay.
 */
export class NonceGuard {
  private readonly seen = new Map<string, number>();
  /** The earliest expiry held, so a full cache is not rescanned for nothing. */
  private earliest = Number.POSITIVE_INFINITY;

  constructor(private readonly options: { readonly max: number; readonly skewMs: number }) {}

  get size(): number {
    return this.seen.size;
  }

  use(key: string, nonce: string, dateMs: number, now: number): "ok" | "replay" | "busy" {
    const entry = `${key}:${nonce}`;
    const known = this.seen.get(entry);
    if (known !== undefined && known >= now) {
      return "replay";
    }
    if (this.seen.size >= this.options.max) {
      this.prune(now);
      if (this.seen.size >= this.options.max) {
        return "busy";
      }
    }
    const expiry = dateMs + this.options.skewMs;
    this.seen.set(entry, expiry);
    this.earliest = Math.min(this.earliest, expiry);
    return "ok";
  }

  /** Forget the nonces whose request could no longer be accepted anyway. */
  prune(now: number): void {
    if (now <= this.earliest) {
      return;
    }
    let earliest = Number.POSITIVE_INFINITY;
    for (const [entry, expiry] of this.seen) {
      if (expiry < now) {
        this.seen.delete(entry);
      } else {
        earliest = Math.min(earliest, expiry);
      }
    }
    this.earliest = earliest;
  }
}

/** Verify the signature over what actually arrived, then burn the nonce. */
export async function verifySignedBody(
  request: SignedHeaders,
  input: {
    readonly method: string;
    readonly path: string;
    readonly domain: string;
    readonly body: Uint8Array;
    readonly nonces: NonceGuard;
    readonly now: number;
  },
): Promise<{ readonly ok: true } | Refusal> {
  const payload = appsSigningPayload({
    method: input.method,
    domain: input.domain,
    path: input.path,
    date: request.date,
    nonce: request.nonce,
    bodySha256Hex: await sha256Hex(input.body),
  });
  if (!(await verifies(request, payload))) {
    return refuse("bad_signature", "the signature does not match the request");
  }
  const used = input.nonces.use(request.key, request.nonce, request.dateMs, input.now);
  if (used === "replay") {
    return refuse("replay", "this request was already received");
  }
  if (used === "busy") {
    return refuse("busy", "the host is busy; retry shortly");
  }
  return { ok: true };
}
