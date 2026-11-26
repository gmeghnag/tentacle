/** The host's plain answers: a page, a line of text, an API error. */
import type { AppsError, AppsErrorCode } from "@tentacle/protocol";
import { COMMON_HEADERS, type NoticeKind, type Page } from "./pages.ts";
import { ERROR_STATUS } from "./routes.ts";

export interface Refused {
  readonly error: AppsErrorCode;
  readonly message: string;
  readonly retryAfterMs?: number;
  readonly reason?: string;
  readonly serverTime?: number;
}

export function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: { ...COMMON_HEADERS, "Content-Type": "text/plain; charset=utf-8", ...headers },
  });
}

export function pageResponse(page: Page, status = 200): Response {
  return new Response(page.body, { status, headers: page.headers });
}

export function errorResponse(refused: Refused): Response {
  const body: AppsError = {
    error: refused.error,
    message: refused.message,
    ...(refused.retryAfterMs === undefined ? {} : { retryAfterMs: refused.retryAfterMs }),
    ...(refused.reason === undefined ? {} : { reason: refused.reason }),
    ...(refused.serverTime === undefined ? {} : { serverTime: refused.serverTime }),
  };
  return Response.json(body, {
    status: ERROR_STATUS[refused.error],
    headers: {
      ...COMMON_HEADERS,
      ...(refused.retryAfterMs === undefined
        ? {}
        : { "Retry-After": String(Math.ceil(refused.retryAfterMs / 1000)) }),
    },
  });
}

export const NOTICE_STATUS: Record<NoticeKind, number> = {
  maintenance: 503,
  unknown: 404,
  taken_down: 410,
  deleted: 410,
  offline: 503,
  over_limit: 503,
};
