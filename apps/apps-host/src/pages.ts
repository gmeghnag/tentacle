/**
 * What the host serves besides an app's own bytes (pure): the fixed templates of
 * its pages, their headers, the headers every app gets, and the one decision
 * that stands between a link and an app (`visitorView`, D5).
 */
import { createHash } from "node:crypto";
import { isAppId } from "@tentacle/protocol";
import { encode } from "uqr";
import type { View } from "./host-core.ts";
import type { HeaderReader } from "./signed-request.ts";

export interface Page {
  readonly body: string;
  readonly headers: Record<string, string>;
}

export interface PagesConfig {
  readonly domain: string;
  readonly abuseEmail: string;
  readonly termsUrl: string;
}

export type NoticeKind = Exclude<View["kind"], "app">;

export const REPORT_REASONS = ["phishing", "malware", "illegal", "other"] as const;
export const REPORT_DETAILS_MAX = 2000;
export const REPORT_CONTACT_MAX = 200;

/**
 * The app only for a top-level navigation started by this very origin — which,
 * before the app is shown, means the warning page's own script. Anything else,
 * and any browser without Fetch Metadata, gets the warning: fails closed.
 */
export function visitorView(headers: HeaderReader): "app" | "warning" {
  return headers.get("sec-fetch-site") === "same-origin" &&
    headers.get("sec-fetch-mode") === "navigate" &&
    headers.get("sec-fetch-dest") === "document"
    ? "app"
    : "warning";
}

/** Where the warning wrapper loads the app, behind its dialog. */
export const FRAME_PATH = "/_frame";

/**
 * The framed copy of the app only for an iframe navigation started by this very
 * origin (the wrapper's own iframe). A top-level visit, another origin's frame
 * and a browser without Fetch Metadata never get it: fails closed.
 */
export function isFrameRequest(headers: HeaderReader): boolean {
  return (
    headers.get("sec-fetch-site") === "same-origin" &&
    headers.get("sec-fetch-mode") === "navigate" &&
    headers.get("sec-fetch-dest") === "iframe"
  );
}

/** Network off; the page can only tighten this with a `<meta>`. */
const APP_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "child-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "sandbox allow-scripts allow-modals allow-same-origin",
].join("; ");

const PERMISSIONS_POLICY = [
  "camera",
  "microphone",
  "geolocation",
  "payment",
  "usb",
  "serial",
  "hid",
  "bluetooth",
  "display-capture",
  "publickey-credentials-get",
]
  .map((feature) => `${feature}=()`)
  .join(", ");

/** On every response the host makes. */
export const COMMON_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store",
} as const;

const APP_VARY = "Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest";

/**
 * The app as shown behind the warning: the same bytes and headers, but it may
 * be framed by this origin alone (and by nobody else, `X-Frame-Options`
 * agreeing). The wrapper's `<iframe sandbox>` takes away the origin.
 */
export function framedAppResponseHeaders(): Record<string, string> {
  const headers = appResponseHeaders();
  return {
    ...headers,
    "Content-Security-Policy": (headers["Content-Security-Policy"] ?? "").replace(
      "frame-ancestors 'none'",
      "frame-ancestors 'self'",
    ),
    "X-Frame-Options": "SAMEORIGIN",
  };
}

export function appResponseHeaders(): Record<string, string> {
  return {
    ...COMMON_HEADERS,
    "Content-Type": "text/html; charset=utf-8",
    "Content-Security-Policy": APP_CSP,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Resource-Policy": "same-origin",
    "Permissions-Policy": PERMISSIONS_POLICY,
    Vary: APP_VARY,
  };
}

/**
 * The mascot (`apps/mobile/src/mascot-scenes.ts` `MASCOT_BITMAP`, cyan palette),
 * drawn as one inline SVG of merged runs: no image request, nothing to hash.
 */
const MASCOT_ROWS = [
  "..KKKKK..",
  ".KSFFFSK.",
  "KSFFFFFSK",
  "KFEFFFEFK",
  "KFEFFFEFK",
  "KBBFSFBBK",
  ".KFFFFFK.",
  "KSSKSKSSK",
  ".KK.K.KK.",
];
const MASCOT_CYAN: Record<string, string> = {
  K: "#0E8AA8",
  E: "#083A47",
  F: "#5FE0F2",
  S: "#3FCFE6",
  B: "#B7F3FB",
};

function mascotSvg(): string {
  const rects: string[] = [];
  MASCOT_ROWS.forEach((row, y) => {
    for (const match of row.matchAll(/([KEFSB])\1*/g)) {
      const tone = match[1] ?? "K";
      rects.push(
        `<rect x="${match.index}" y="${y}" width="${match[0].length}" height="1" fill="${MASCOT_CYAN[tone]}"/>`,
      );
    }
  });
  return `<svg class="logo" viewBox="0 0 9 9" width="26" height="26" shape-rendering="crispEdges" aria-hidden="true" focusable="false">${rects.join("")}</svg>`;
}

const MASCOT = mascotSvg();

/**
 * A QR of `text` as one inline SVG: a single `<path>` of unit modules on a
 * white square with a 4-module quiet zone. Always dark on light, in the dark
 * theme too, so it scans in both. Presentation attributes only (no `style=`).
 */
export function qrSvg(text: string): string {
  const matrix = encode(text, { ecc: "M", border: 0 }).data;
  const border = 4;
  const size = matrix.length + border * 2;
  let path = "";
  matrix.forEach((row, y) => {
    for (const match of row
      .map((on) => (on ? "1" : "0"))
      .join("")
      .matchAll(/1+/g)) {
      path += `M${match.index + border} ${y + border}h${match[0].length}v1h-${match[0].length}z`;
    }
  });
  return `<svg class="qr-code" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges" role="img" aria-label="QR code of this page's address"><rect width="${size}" height="${size}" fill="#ffffff"/><path d="${path}" fill="#000000"/></svg>`;
}

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f6f4f9;
  --fg: #231a30;
  --muted: #62586f;
  --line: #d9d2e3;
  --field: #ffffff;
  --accent: #5b2a86;
  --on-accent: #ffffff;
  --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, system-ui, Roboto, sans-serif;
  --mono: ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #17131d;
    --fg: #ece7f3;
    --muted: #a99fb8;
    --line: #3a3248;
    --field: #1f1928;
    --accent: #c9a6f2;
    --on-accent: #1d1030;
  }
}
* { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; }
body {
  margin: 0;
  min-height: 100vh;
  min-height: 100dvh;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.6 var(--sans);
  -webkit-font-smoothing: antialiased;
  padding: max(2rem, env(safe-area-inset-top)) max(1.5rem, env(safe-area-inset-right)) max(2rem, env(safe-area-inset-bottom)) max(1.5rem, env(safe-area-inset-left));
  display: flex;
  justify-content: center;
}
main { width: 100%; max-width: 26rem; margin-top: clamp(1rem, 9vh, 6rem); }
.brand { display: flex; align-items: center; gap: .6rem; margin: 0 0 2.5rem; font-size: .9375rem; font-weight: 600; letter-spacing: .01em; color: var(--muted); }
.logo { display: block; flex: none; }
h1 { margin: 0 0 1rem; font-size: 1.75rem; line-height: 1.2; font-weight: 650; letter-spacing: -.02em; }
p { margin: 0 0 1rem; color: var(--muted); }
p.lead { color: var(--fg); font-size: 1.0625rem; }
p strong { color: var(--fg); font-weight: 650; }
a { color: var(--accent); text-underline-offset: .2em; }
a:hover { text-decoration-thickness: 2px; }
code, .mono { font-family: var(--mono); font-size: .875em; }
button { font: inherit; font-weight: 600; letter-spacing: .005em; min-height: 2.75rem; padding: .6rem 1.5rem; border: 0; border-radius: .6rem; background: var(--accent); color: var(--on-accent); cursor: pointer; width: 100%; -webkit-appearance: none; appearance: none; }
button:hover { filter: brightness(1.08); }
button:active { filter: brightness(.94); }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.actions { margin: 1.75rem 0 1rem; }
.quiet { display: inline-flex; align-items: center; min-height: 2.75rem; font-size: .9375rem; }
.foot { margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--line); font-size: .875rem; color: var(--muted); }
.foot p { font-size: inherit; margin: 0 0 .25rem; }
label { display: block; margin: 0 0 1.25rem; font-size: .875rem; font-weight: 600; color: var(--fg); }
label small { font-weight: 400; color: var(--muted); }
input, select, textarea { display: block; width: 100%; margin-top: .4rem; min-height: 2.75rem; padding: .6rem .75rem; font: inherit; font-size: 1rem; font-weight: 400; color: var(--fg); background: var(--field); border: 1px solid var(--line); border-radius: .6rem; }
input[name="app"] { font-family: var(--mono); font-size: .9375rem; }
textarea { resize: vertical; line-height: 1.5; }
input:focus-visible, select:focus-visible, textarea:focus-visible { outline: 3px solid var(--accent); outline-offset: 0; border-color: var(--accent); }
.qr { display: none; }
.qr-code { display: block; width: 11rem; height: 11rem; border-radius: .5rem; }
.qr-url { margin: .5rem 0 0; font-family: var(--mono); font-size: .8125rem; word-break: break-all; }
body.wrap { display: block; min-height: 0; padding: 0; overflow: hidden; }
.app-frame { position: fixed; inset: 0; width: 100%; height: 100%; border: 0; background: #fff; pointer-events: none; }
.overlay { position: fixed; inset: 0; z-index: 2; display: flex; align-items: center; justify-content: center; overflow-y: auto; background: rgba(23, 19, 29, .45); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px); padding: max(1rem, env(safe-area-inset-top)) max(1rem, env(safe-area-inset-right)) max(1rem, env(safe-area-inset-bottom)) max(1rem, env(safe-area-inset-left)); }
.dialog { width: 100%; max-width: 26rem; max-height: 100%; overflow-y: auto; background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 1rem; padding: 1.5rem; box-shadow: 0 1.5rem 4rem rgba(0, 0, 0, .35); }
.dialog .brand { margin-bottom: 1.5rem; }
.dialog h1 { font-size: 1.5rem; }
.dialog .actions { margin-top: 1.25rem; }
.dialog .foot { margin-top: 1rem; padding-top: 1rem; }
.dialog .qr { margin-top: 1rem; padding-top: 1rem; }
.dialog .qr-code { width: 9rem; height: 9rem; }
@media (min-width: 700px) {
  .qr { display: block; margin-top: 1.5rem; padding-top: 1.25rem; border-top: 1px solid var(--line); }
  .qr p { margin-bottom: .75rem; font-size: .875rem; }
}
@media (min-width: 640px) {
  main { margin-top: 12vh; }
  h1 { font-size: 2rem; }
  .dialog h1 { font-size: 1.75rem; }
  button { width: auto; min-width: 11rem; }
}
`;

/**
 * The warning's script. Acknowledged once in this browser, the page forwards by
 * itself to the app (a top-level load, no frame). Otherwise it starts loading
 * the app behind the dialog; Continue acknowledges and reloads. The 3 s guard
 * stops a loop in a browser that sends no Fetch Metadata. The fragment is
 * dropped: a URL differing only by it would not load anything.
 */
const WARNING_SCRIPT = `
(function () {
  var ACK = "tentacle-apps-ack";
  var AT = "tentacle-apps-forwarded";
  var stuck = document.getElementById("stuck");
  var frame = document.getElementById("app-frame");
  function forward() {
    location.replace(location.href.split("#")[0]);
  }
  function recently() {
    var last = Number(sessionStorage.getItem(AT));
    return last > 0 && Date.now() - last < 3000;
  }
  document.getElementById("continue").addEventListener("click", function () {
    try { localStorage.setItem(ACK, "1"); } catch (e) {}
    try { sessionStorage.setItem(AT, String(Date.now())); } catch (e) {}
    forward();
  });
  try {
    if (recently()) {
      stuck.hidden = false;
    } else if (localStorage.getItem(ACK) === "1") {
      sessionStorage.setItem(AT, String(Date.now()));
      forward();
      return;
    }
  } catch (e) {}
  frame.src = ${JSON.stringify(FRAME_PATH)};
  frame.hidden = false;
  document.getElementById("continue").focus();
})();
`;

const sha256Source = (text: string): string =>
  `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

const STYLE_SOURCE = sha256Source(STYLE);
const SCRIPT_SOURCE = sha256Source(WARNING_SCRIPT);

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * The warning's document: the app loads full-viewport in a sandboxed iframe
 * (scripts only, no origin: it cannot touch this page), inert behind the
 * dialog.
 */
function wrapperDocument(title: string, dialog: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${title} · tentacle apps</title>
<style>${STYLE}</style>
</head>
<body class="wrap">
<iframe id="app-frame" class="app-frame" sandbox="allow-scripts" title="The app, behind the notice" aria-hidden="true" tabindex="-1" inert hidden></iframe>
<div class="overlay">
<div class="dialog" role="dialog" aria-modal="true" aria-labelledby="dialog-title">
<p class="brand">${MASCOT}<span>tentacle apps</span></p>
<h1 id="dialog-title">${title}</h1>
${dialog}
</div>
</div>
<script>${WARNING_SCRIPT}</script>
</body>
</html>
`;
}

function page(
  title: string,
  content: string,
  options: { script?: boolean; form?: boolean; wrapper?: boolean } = {},
): Page {
  const script = options.script === true;
  const csp = [
    "default-src 'none'",
    `style-src ${STYLE_SOURCE}`,
    ...(script ? [`script-src ${SCRIPT_SOURCE}`] : []),
    `form-action ${options.form === true ? "'self'" : "'none'"}`,
    ...(options.wrapper !== true ? [] : ["frame-src 'self'"]),
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const body =
    options.wrapper === true
      ? wrapperDocument(title, content)
      : `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} · tentacle apps</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<p class="brand">${MASCOT}<span>tentacle apps</span></p>
<h1>${title}</h1>
${content}
</main>
${script ? `<script>${WARNING_SCRIPT}</script>\n` : ""}</body>
</html>
`;
  return {
    body,
    headers: {
      ...COMMON_HEADERS,
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": csp,
    },
  };
}

const NOTICES: Record<NoticeKind, [title: string, text: string]> = {
  unknown: ["No such app", "There is no app at this address."],
  taken_down: ["Removed", "This app was removed by the operator."],
  deleted: ["Unpublished", "This app was unpublished by whoever published it."],
  offline: ["Offline", "The tentacle session that published this app is not running."],
  over_limit: [
    "Over its daily limit",
    "This app is over its daily limit. It comes back tomorrow (UTC).",
  ],
  maintenance: ["Temporarily unavailable", "Apps are temporarily unavailable."],
};

export function createPages(config: PagesConfig) {
  const email = escapeHtml(config.abuseEmail);
  const terms = escapeHtml(config.termsUrl);
  const mail = `<a href="mailto:${email}">${email}</a>`;
  /** The id, only when it is one. */
  const safeId = (id: string | undefined): string | undefined =>
    id !== undefined && isAppId(id) ? id : undefined;

  return {
    warning(id: string): Page {
      const app = safeId(id);
      const report = `https://${escapeHtml(config.domain)}/report${app === undefined ? "" : `?app=${app}`}`;
      // The canonical address, from the validated id and the configured domain
      // only: never the Host header or the query.
      const canonical = app === undefined ? undefined : `https://${app}.${config.domain}/`;
      const qr =
        canonical === undefined
          ? ""
          : `\n<div class="qr"><p>Open on your phone</p>${qrSvg(canonical)}<p class="qr-url">${escapeHtml(canonical)}</p></div>`;
      return page(
        "Before you continue",
        `<p class="lead">This page was published by a tentacle user, not by tentacle. tentacle does not review it.</p>
<p><strong>Do not enter passwords or personal data.</strong></p>
<div class="actions"><button type="button" id="continue">Continue</button></div>
<p id="stuck" hidden>This browser cannot open the app. Try a current version of Safari, Chrome or Firefox.</p>
<p><a class="quiet" href="${report}">Report this page</a></p>${qr}
<div class="foot"><p>Or write to ${mail}.</p></div>`,
        { script: true, wrapper: true },
      );
    },
    notice(kind: NoticeKind): Page {
      const [title, text] = NOTICES[kind];
      return page(
        title,
        `<p class="lead">${text}</p>\n<div class="foot"><p>Abuse reports: ${mail}</p></div>`,
      );
    },
    info(): Page {
      return page(
        "tentacle apps",
        `<p class="lead">This service hosts single-page apps published by tentacle users, each at its own address, for as long as the session that published it runs. tentacle does not review them.</p>
<div class="foot"><p>Report abuse: ${mail}</p>
<p><a class="quiet" href="${terms}">Terms</a></p></div>`,
      );
    },
    report(id: string | undefined): Page {
      const app = safeId(id) ?? "";
      const options = REPORT_REASONS.map(
        (reason) => `<option value="${reason}">${reason}</option>`,
      ).join("");
      return page(
        "Report an app",
        `<form method="post" action="/v1/report">
<label>App id <input name="app" required maxlength="16" value="${app}" autocapitalize="none" autocomplete="off" spellcheck="false"></label>
<label>Reason <select name="reason">${options}</select></label>
<label>Details <textarea name="details" rows="5" maxlength="${REPORT_DETAILS_MAX}"></textarea></label>
<label>Contact <small>(optional)</small> <input name="contact" maxlength="${REPORT_CONTACT_MAX}"></label>
<div class="actions"><button type="submit">Send report</button></div>
</form>
<div class="foot"><p>The report, your address and the time are kept for up to 30 days. You can also write to ${mail}.</p></div>`,
        { form: true },
      );
    },
    thanks(): Page {
      return page("Report received", `<p class="lead">Thank you. A person will look at it.</p>`);
    },
    reportRefused(): Page {
      return page(
        "Report not saved",
        `<p class="lead">We could not take your report now. Write to ${mail}.</p>`,
      );
    },
  };
}

export type Pages = ReturnType<typeof createPages>;
