/** Where a request lands, and the HTTP status of each API error (pure). */
import type { AppsErrorCode } from "@tentacle/protocol";

export type ControlRoute =
  | { readonly kind: "create" }
  | { readonly kind: "update" | "delete" | "renew"; readonly id: string }
  | { readonly kind: "health" | "info" | "report_form" | "report" | "thanks" | "robots" }
  | { readonly kind: "method_not_allowed"; readonly allow: string }
  | { readonly kind: "not_found" };

const PAGES = new Map<string, "health" | "info" | "report_form" | "thanks" | "robots">([
  ["/healthz", "health"],
  ["/", "info"],
  ["/report", "report_form"],
  ["/report/thanks", "thanks"],
  ["/robots.txt", "robots"],
]);

const APP_PATH = /^\/v1\/apps\/([a-z2-7]{16})(\/lease)?$/;

const notAllowed = (allow: string): ControlRoute => ({ kind: "method_not_allowed", allow });

/** Routes of the control host. A known path with another method is a 405. */
export function controlRoute(method: string, path: string): ControlRoute {
  const page = PAGES.get(path);
  if (page !== undefined) {
    return method === "GET" || method === "HEAD" ? { kind: page } : notAllowed("GET, HEAD");
  }
  if (path === "/v1/report") {
    return method === "POST" ? { kind: "report" } : notAllowed("POST");
  }
  if (path === "/v1/apps") {
    return method === "POST" ? { kind: "create" } : notAllowed("POST");
  }
  const match = APP_PATH.exec(path);
  const id = match?.[1];
  if (id === undefined) {
    return { kind: "not_found" };
  }
  if (match?.[2] !== undefined) {
    return method === "POST" ? { kind: "renew", id } : notAllowed("POST");
  }
  if (method === "PUT") {
    return { kind: "update", id };
  }
  return method === "DELETE" ? { kind: "delete", id } : notAllowed("PUT, DELETE");
}

export const ERROR_STATUS: Record<AppsErrorCode, number> = {
  bad_request: 400,
  bad_signature: 401,
  clock_skew: 401,
  replay: 409,
  not_found: 404,
  forbidden: 403,
  blocked: 403,
  taken_down: 403,
  expired: 410,
  deleted: 410,
  too_large: 413,
  unsupported_media: 415,
  malformed: 400,
  rate_limited: 429,
  cap_reached: 409,
  conflict: 409,
  storage_full: 507,
  killed: 503,
  busy: 503,
  internal: 500,
};
