/**
 * What the host serves besides an app's own bytes (pure): the fixed templates of
 * its pages, their headers, the headers every app gets, and the one decision
 * that stands between a link and an app (`visitorView`, D5).
 */
import { createHash } from "node:crypto";
import { isAppId } from "@tentacle/protocol";
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

const STYLE = `
:root { color-scheme: light dark; }
body { font: 16px/1.5 system-ui, sans-serif; max-width: 34rem; margin: 12vh auto; padding: 0 1.25rem; }
h1 { font-size: 1.35rem; }
button { font: inherit; padding: .5rem 1.25rem; }
label { display: block; margin: .75rem 0; }
input, select, textarea { display: block; width: 100%; box-sizing: border-box; font: inherit; padding: .35rem; }
`;

/**
 * The warning's script. Acknowledged once in this browser, the page forwards by
 * itself; the 3 s guard stops a loop in a browser that sends no Fetch Metadata.
 * The fragment is dropped: a URL differing only by it would not load anything.
 */
const WARNING_SCRIPT = `
(function () {
  var ACK = "tentacle-apps-ack";
  var AT = "tentacle-apps-forwarded";
  var stuck = document.getElementById("stuck");
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
    }
  } catch (e) {}
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

function page(
  title: string,
  content: string,
  options: { script?: boolean; form?: boolean } = {},
): Page {
  const script = options.script === true;
  const csp = [
    "default-src 'none'",
    `style-src ${STYLE_SOURCE}`,
    ...(script ? [`script-src ${SCRIPT_SOURCE}`] : []),
    `form-action ${options.form === true ? "'self'" : "'none'"}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  const body = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLE}</style>
</head>
<body>
<h1>${title}</h1>
${content}
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
      return page(
        "Before you continue",
        `<p>This page was published by a tentacle user, not by tentacle. tentacle does not review it.</p>
<p><strong>Do not enter passwords or personal data.</strong></p>
<p><button type="button" id="continue">Continue</button></p>
<p id="stuck" hidden>This browser cannot open the app. Try a current version of Safari, Chrome or Firefox.</p>
<p><a href="${report}">Report this page</a> or write to ${mail}.</p>`,
        { script: true },
      );
    },
    notice(kind: NoticeKind): Page {
      const [title, text] = NOTICES[kind];
      return page(title, `<p>${text}</p>\n<p>Abuse reports: ${mail}</p>`);
    },
    info(): Page {
      return page(
        "tentacle apps",
        `<p>This service hosts single-page apps published by tentacle users, each at its own address, for as long as the session that published it runs. tentacle does not review them.</p>
<p>Report abuse: ${mail}</p>
<p><a href="${terms}">Terms</a></p>`,
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
<label>App id <input name="app" required maxlength="16" value="${app}"></label>
<label>Reason <select name="reason">${options}</select></label>
<label>Details <textarea name="details" rows="5" maxlength="${REPORT_DETAILS_MAX}"></textarea></label>
<label>Contact (optional) <input name="contact" maxlength="${REPORT_CONTACT_MAX}"></label>
<p><button type="submit">Send report</button></p>
</form>
<p>The report, your address and the time are kept for up to 30 days. You can also write to ${mail}.</p>`,
        { form: true },
      );
    },
    thanks(): Page {
      return page("Report received", "<p>Thank you. A person will look at it.</p>");
    },
    reportRefused(): Page {
      return page(
        "Report not saved",
        `<p>We could not take your report now. Write to ${mail}.</p>`,
      );
    },
  };
}

export type Pages = ReturnType<typeof createPages>;
