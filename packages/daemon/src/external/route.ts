/**
 * The protocol-neutral HTTP guard of an external caller's route (docs/feat/a2a.md
 * S9; A2A today, MCP next — owner decision 2026-11-25): the dedicated caller
 * token, the browser-`Origin` refusal and the bounded body. The wire mapping
 * (JSON-RPC, cards, SSE) stays in the protocol's own module.
 */
import { tokensMatch } from "../ws-server.ts";

/** One caller: its name (`default` from the CLI) and its own bearer token. */
export interface ExternalCaller {
  readonly name: string;
  readonly token: string;
}

/** What a route needs from Bun's server (lifts the idle timeout of a long call). */
export interface TimeoutServer {
  timeout(req: Request, seconds: number): void;
  /**
   * The peer address, when the server can say (Bun's `Server` does; a fake or
   * hand-rolled `srv` may not). Optional: absent degrades to `at unknown` in the
   * audit line, never a throw.
   */
  readonly requestIP?: (req: Request) => { readonly address: string } | null;
}

/**
 * One external caller's route (`/a2a`, `/mcp`), asked by `startWsServer` FIRST
 * on every request: a response when it owns the path, undefined = not ours,
 * fall through (every other path behaves exactly as without it).
 */
export interface ExternalRoute {
  handle(req: Request, srv: TimeoutServer): Response | Promise<Response> | undefined;
}

/** Default cap of one request body (1 MiB). */
export const EXTERNAL_MAX_BODY_BYTES = 1024 * 1024;

/**
 * Which caller this request's bearer token names — null when there is none, it
 * matches no caller, or the request carries a browser `Origin` (a visited web
 * page must never drive the route, even with a token it somehow holds).
 * The token is read from `Authorization: Bearer` only, never from the URL.
 */
export function authenticateCaller(
  req: Request,
  callers: readonly ExternalCaller[],
): string | null {
  if (req.headers.get("origin") !== null) {
    return null;
  }
  const auth = req.headers.get("authorization");
  if (auth === null || !auth.startsWith("Bearer ")) {
    return null;
  }
  const provided = auth.slice("Bearer ".length);
  if (provided === "") {
    return null;
  }
  // Compare against EVERY caller (no early exit on the first match's position).
  let found: string | null = null;
  for (const caller of callers) {
    if (tokensMatch(provided, caller.token) && found === null) {
      found = caller.name;
    }
  }
  return found;
}

/** The request body as text, or `"too-large"` once it passes `max` bytes (never buffers past it). */
export async function readBoundedBody(req: Request, max: number): Promise<string | "too-large"> {
  const declared = Number(req.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) {
    return "too-large";
  }
  if (req.body === null) {
    return "";
  }
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return "too-large";
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    all.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder().decode(all);
}
