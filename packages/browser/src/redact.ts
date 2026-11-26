// browserRedact — structure-aware masking of everything page-derived the model
// may see (docs/feat/browser-inspect.md §3). Pure: applied by the daemon-side
// tool BEFORE a ToolResult exists. Names are kept, values masked; the tag is an
// HMAC with a per-session random key so the model can correlate "the same
// token as request 12" without a dictionary-checkable hash.
import { createHmac } from "node:crypto";

const SECRET_NAME = /(token|secret|key|auth|session|signature|password|passwd)/i;
const SECRET_EXACT = new Set(["code", "state", "sig", "sid", "pwd", "otp", "jwt", "nonce"]);
const SECRET_HEADER_PREFIX = /^(x-csrf|x-xsrf)/i;
const ALWAYS_HEADERS = new Set(["authorization", "proxy-authorization", "cookie", "set-cookie"]);

export function isSecretName(name: string): boolean {
  let n = name;
  try {
    n = decodeURIComponent(name);
  } catch {
    // keep the raw name
  }
  n = n.trim().toLowerCase();
  return SECRET_EXACT.has(n) || SECRET_NAME.test(n);
}

export function isSecretHeader(name: string): boolean {
  const n = name.trim().toLowerCase();
  return ALWAYS_HEADERS.has(n) || SECRET_HEADER_PREFIX.test(n) || isSecretName(n);
}

export type Redactor = {
  /** `‹masked <kind> <name> · <n> chars · #tag›` */
  mask(kind: string, name: string, value: string): string;
  /** Mask every secret header value; other headers pass through. */
  headers(h: Record<string, string>): Record<string, string>;
  /** A `Cookie:` value (`a=1; b=2`): names kept, values masked. */
  cookieHeader(value: string): string;
  /** A `Set-Cookie:` value: the cookie's value masked, attributes kept. */
  setCookie(value: string): string;
  /** Mask secret query/fragment params in every URL inside `s`. */
  url(s: string): string;
  /** A body (JSON / urlencoded / multipart / other text). Others unchanged. */
  body(text: string, contentType?: string): string;
};

function randomKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export function createRedactor(key: Uint8Array = randomKey()): Redactor {
  const tag = (v: string): string => createHmac("sha256", key).update(v).digest("hex").slice(0, 6);
  const mask = (kind: string, name: string, value: string): string =>
    `‹masked ${kind} ${name} · ${value.length} chars · #${tag(value)}›`;

  const url = (s: string): string =>
    s.replace(
      /([?&#;])([^=&#;\s"'<>]+)=([^&#;\s"'<>]*)/g,
      (m, sep: string, name: string, val: string) =>
        val !== "" && isSecretName(name) ? `${sep}${name}=${mask("param", name, val)}` : m,
    );

  const cookieHeader = (value: string): string =>
    value
      .split(";")
      .map((part) => {
        const i = part.indexOf("=");
        if (i < 0) return part;
        const name = part.slice(0, i).trim();
        return `${part.slice(0, i).replace(/\s+$/, "")}=${mask("cookie", name, part.slice(i + 1).trim())}`;
      })
      .join(";");

  const setCookie = (value: string): string => {
    const [first = "", ...attrs] = value.split(";");
    const i = first.indexOf("=");
    if (i < 0) return value;
    const name = first.slice(0, i).trim();
    return [`${name}=${mask("cookie", name, first.slice(i + 1).trim())}`, ...attrs].join(";");
  };

  const headers = (h: Record<string, string>): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(h)) {
      const n = name.toLowerCase();
      if (n === "cookie") out[name] = cookieHeader(value);
      else if (n === "set-cookie") out[name] = value.split("\n").map(setCookie).join("\n");
      else if (isSecretHeader(name)) out[name] = mask("header", name, value);
      else out[name] = url(value);
    }
    return out;
  };

  const json = (v: unknown, name?: string): unknown => {
    if (name !== undefined && isSecretName(name) && v !== null && v !== undefined) {
      return mask("json", name, typeof v === "string" ? v : JSON.stringify(v));
    }
    if (Array.isArray(v)) return v.map((x) => json(x, undefined));
    if (v !== null && typeof v === "object") {
      const o: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) o[k] = json(x, k);
      return o;
    }
    return typeof v === "string" ? url(v) : v;
  };

  const form = (text: string): string =>
    text
      .split("&")
      .map((pair) => {
        const i = pair.indexOf("=");
        if (i < 0) return pair;
        const name = pair.slice(0, i);
        const val = pair.slice(i + 1);
        return val !== "" && isSecretName(name) ? `${name}=${mask("field", name, val)}` : pair;
      })
      .join("&");

  const multipart = (text: string): string =>
    text.replace(
      /(name="([^"]*)"[^\r\n]*\r?\n(?:[^\r\n]+\r?\n)*\r?\n)([\s\S]*?)(\r?\n--)/g,
      (m, head: string, name: string, val: string, tail: string) =>
        val !== "" && isSecretName(name) ? `${head}${mask("field", name, val)}${tail}` : m,
    );

  const body = (text: string, contentType = ""): string => {
    const ct = contentType.toLowerCase();
    if (ct.includes("multipart/form-data")) return multipart(text);
    if (ct.includes("x-www-form-urlencoded")) return form(text);
    const t = text.trimStart();
    if (ct.includes("json") || t.startsWith("{") || t.startsWith("[")) {
      try {
        return JSON.stringify(json(JSON.parse(text)));
      } catch {
        // not JSON after all: fall through to the URL/param net
      }
    }
    return url(text);
  };

  return { mask, headers, cookieHeader, setCookie, url, body };
}

/**
 * The «clear» mode's redactor (docs/feat/browser-inspect.md B5b): the same
 * interface, every value passed through. Used ONLY for a tool result while the
 * session's `secrets` switch says `clear`; an ask's title and detail are still
 * masked (they travel to the phone and to notifications).
 */
export const IDENTITY_REDACTOR: Redactor = {
  mask: (_kind, _name, value) => value,
  headers: (h) => ({ ...h }),
  cookieHeader: (value) => value,
  setCookie: (value) => value,
  url: (s) => s,
  body: (text) => text,
};
