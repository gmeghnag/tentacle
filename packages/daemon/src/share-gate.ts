/**
 * What a visitor of a shared container port may do, on the serve, per request
 * (docs/feat/session-apps-container-ports.md OD4/OD5). Pure. The apps host is
 * only a pipe: the secret is checked HERE, nothing but an origin-form request is
 * ever dialled, and the upstream is the one fixed loopback origin.
 */
import { timingSafeEqual } from "node:crypto";

/** `__Host-`: host-only, so never sent to the apps domain or a sibling app. */
export const SHARE_COOKIE = "__Host-tentacle-cap";
/** Paths that are the serve's own: never forwarded. */
const OWN_PATHS = "/__tentacle/";
export const SHARE_CAP_PATH = `${OWN_PATHS}cap/`;

export interface ShareRequest {
  readonly method: string;
  readonly target: string;
  readonly headers: readonly (readonly [string, string])[];
}

export type ShareDecision =
  /** Answered here; nothing is dialled. */
  | {
      readonly kind: "respond";
      readonly status: number;
      readonly headers: [string, string][];
      readonly body: string;
    }
  /** Go on, with these headers (the capability cookie removed). */
  | { readonly kind: "forward"; readonly headers: [string, string][] };

function respond(status: number, body: string, headers: [string, string][] = []): ShareDecision {
  return {
    kind: "respond",
    status,
    headers: [
      ["content-type", "text/plain; charset=utf-8"],
      ["cache-control", "no-store"],
      ...headers,
    ],
    body,
  };
}

const encoder = new TextEncoder();

/** Constant-time on equal lengths; the secret's length is not secret. */
function same(given: string, secret: string): boolean {
  const a = encoder.encode(given);
  const b = encoder.encode(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Origin-form only: `/…`, never `//…` or `/\…` (another authority), `*` or an
 * absolute URL; never `CONNECT`, `TRACE` or `TRACK`.
 */
function originForm(method: string, target: string): boolean {
  return !/^(connect|trace|track)$/i.test(method) && /^\/(?![/\\])/.test(target);
}

const cookiesOf = (value: string): string[] =>
  value
    .split(";")
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "");

const nameOf = (pair: string): string => (pair.split("=", 1)[0] ?? "").trim();

/** `secret`: absent for a PUBLIC share. */
export function shareGate(request: ShareRequest, secret: string | undefined): ShareDecision {
  const { method, target } = request;
  if (!originForm(method, target)) {
    return respond(400, "bad request\n");
  }
  const path = target.split("?", 1)[0] ?? "";
  if (path.startsWith(OWN_PATHS) || path === OWN_PATHS.slice(0, -1)) {
    const given = path.startsWith(SHARE_CAP_PATH) ? path.slice(SHARE_CAP_PATH.length) : "";
    if (secret === undefined || method !== "GET" || !same(given, secret)) {
      return respond(404, "not found\n");
    }
    // The secret is never the document's URL: no Referer carries it.
    return respond(303, "", [
      ["location", "/"],
      ["set-cookie", `${SHARE_COOKIE}=${secret}; Path=/; Secure; HttpOnly; SameSite=Lax`],
    ]);
  }
  let allowed = secret === undefined;
  const headers: [string, string][] = [];
  for (const [name, value] of request.headers) {
    if (name.toLowerCase() !== "cookie") {
      headers.push([name, value]);
      continue;
    }
    const kept: string[] = [];
    for (const pair of cookiesOf(value)) {
      if (nameOf(pair) !== SHARE_COOKIE) {
        kept.push(pair);
      } else if (secret !== undefined && same(pair.slice(pair.indexOf("=") + 1), secret)) {
        allowed = true;
      }
    }
    if (kept.length > 0) {
      headers.push([name, kept.join("; ")]);
    }
  }
  if (!allowed) {
    return respond(403, "This link needs its secret. Ask whoever shared it for the full link.\n");
  }
  return { kind: "forward", headers };
}

/** Per-connection headers, dropped in both directions. */
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

const hopByHop = (name: string): boolean => HOP_BY_HOP.has(name) || name.startsWith("proxy-");

export interface Upstream {
  /** Always on `http://127.0.0.1:<hostPort>`. */
  readonly url: string;
  readonly headers: [string, string][];
}

/**
 * The request the container gets: what the owner's own browser on this machine
 * would send. `undefined`: it cannot be built on the fixed origin.
 */
export function upstreamRequest(
  request: ShareRequest,
  to: { readonly hostPort: number; readonly publicOrigin: string },
): Upstream | undefined {
  if (!originForm(request.method, request.target)) return undefined;
  const origin = `http://127.0.0.1:${to.hostPort}`;
  const url = URL.canParse(request.target, origin) ? new URL(request.target, origin) : undefined;
  // The parser strips tabs and newlines: assert on what it built.
  if (url === undefined || url.origin !== origin) return undefined;
  const named = new Set(
    request.headers
      .filter(([name]) => name.toLowerCase() === "connection")
      .flatMap(([, value]) => value.split(",").map((token) => token.trim().toLowerCase())),
  );
  const local = `localhost:${to.hostPort}`;
  const headers: [string, string][] = [];
  for (const [name, value] of request.headers) {
    const lower = name.toLowerCase();
    if (
      hopByHop(lower) ||
      named.has(lower) ||
      lower === "host" ||
      lower === "forwarded" ||
      lower.startsWith("x-forwarded-") ||
      // The body is re-framed by this side's own client.
      lower === "content-length" ||
      lower === "expect" ||
      lower.startsWith("sec-websocket-")
    ) {
      continue;
    }
    headers.push([
      lower,
      lower === "origin" && value === to.publicOrigin ? `http://${local}` : value,
    ]);
  }
  headers.push(
    ["host", local],
    ["x-forwarded-proto", "https"],
    ["x-forwarded-host", new URL(to.publicOrigin).host],
  );
  return { url: url.href, headers };
}

/** A cookie that would reach beyond the app's host, or forge the capability's. */
function tossed(cookie: string): boolean {
  return /;\s*domain\s*=/i.test(cookie) || nameOf(cookie.trim()) === SHARE_COOKIE;
}

/** The container's response headers as they may leave this machine. */
export function filterResponseHeaders(
  headers: readonly (readonly [string, string])[],
): [string, string][] {
  const out: [string, string][] = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (hopByHop(lower) || (lower === "set-cookie" && tossed(value))) continue;
    out.push([name, value]);
  }
  return out;
}
