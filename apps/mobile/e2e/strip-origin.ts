/**
 * The harness's strip-origin proxy (docs/feat/mobile-app-shell.md, Owner Q4).
 * `serve` rejects any `Origin` (packages/daemon/src/ws-server.ts:116-121) and
 * iOS's SocketRocket always sends one (mobile-spike.md:149-151), so until task
 * 9's Origin policy the E2E dials this byte-level proxy, which removes exactly
 * the `Origin:` header from the upgrade request and forwards everything else
 * untouched.
 *
 * TEST-ONLY: nothing in the app imports this, and the gate never weakens — the
 * harness switches to a direct dial when task 9 lands.
 *
 * `stripOrigin` is pure (a string in, a string out) so the rewrite is tested
 * byte-for-byte without a socket.
 */

export interface StrippedHead {
  /** The request head, byte-identical except that the `Origin:` line is gone. */
  readonly head: string;
  /** The value that was removed, or null when the client sent none. */
  readonly origin: string | null;
}

/**
 * Remove the `Origin:` header line from an HTTP request head. The header name is
 * matched case-insensitively (RFC 9110 field names are), the CRLF that belongs
 * to that line goes with it, and every other byte is preserved — a proxy that
 * reformats would hide the very bug it is there to let us find.
 */
export function stripOrigin(head: string): StrippedHead {
  const lines = head.split("\r\n");
  let origin: string | null = null;
  const kept: string[] = [];
  for (const line of lines) {
    const colon = line.indexOf(":");
    if (colon > 0 && line.slice(0, colon).trim().toLowerCase() === "origin") {
      // Last one wins for the reported value; every Origin line is removed.
      origin = line.slice(colon + 1).trim();
      continue;
    }
    kept.push(line);
  }
  return { head: kept.join("\r\n"), origin };
}

/**
 * The end of an HTTP head: index of the CRLFCRLF that closes it, or -1.
 * Typed for any byte carrier (a Node `Buffer` is a `Uint8Array`).
 */
export function headEnd(bytes: Uint8Array<ArrayBufferLike>): number {
  for (let i = 0; i + 3 < bytes.length; i += 1) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && bytes[i + 2] === 13 && bytes[i + 3] === 10) {
      return i;
    }
  }
  return -1;
}
