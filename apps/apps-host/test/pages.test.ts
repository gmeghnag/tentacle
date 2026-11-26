import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { encode } from "uqr";
import {
  type Page,
  appResponseHeaders,
  createPages,
  framedAppResponseHeaders,
  isFrameRequest,
  visitorView,
} from "../src/pages.ts";

const ID = "abcdefghijklmnop";
const CONFIG = {
  domain: "apps.example.so",
  abuseEmail: `abuse+"<x>&'@example.so`,
  termsUrl: "https://example.so/terms?a=1&b=2",
};
const ESCAPED_EMAIL = "abuse+&quot;&lt;x&gt;&amp;&#39;@example.so";

const pages = createPages(CONFIG);
const all: [string, Page][] = [
  ["warning", pages.warning(ID)],
  ["unknown", pages.notice("unknown")],
  ["taken_down", pages.notice("taken_down")],
  ["deleted", pages.notice("deleted")],
  ["offline", pages.notice("offline")],
  ["over_limit", pages.notice("over_limit")],
  ["maintenance", pages.notice("maintenance")],
  ["info", pages.info()],
  ["report", pages.report(ID)],
  ["report-empty", pages.report(undefined)],
  ["thanks", pages.thanks()],
  ["report-refused", pages.reportRefused()],
];

const hashOf = (text: string): string =>
  `'sha256-${createHash("sha256").update(text).digest("base64")}'`;

/** The inline blocks of one tag, exactly as the browser hashes them. */
function inline(body: string, tag: "style" | "script"): string[] {
  return [...body.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, "g"))].map(
    (m) => m[1] ?? "",
  );
}

function directives(csp: string): Map<string, string> {
  return new Map(
    csp.split(";").map((part) => {
      const [name, ...rest] = part.trim().split(/\s+/);
      return [name ?? "", rest.join(" ")];
    }),
  );
}

describe("visitorView", () => {
  const view = (site?: string, mode?: string, dest?: string) => {
    const headers = new Headers();
    if (site !== undefined) headers.set("sec-fetch-site", site);
    if (mode !== undefined) headers.set("sec-fetch-mode", mode);
    if (dest !== undefined) headers.set("sec-fetch-dest", dest);
    return visitorView(headers);
  };

  test("only a same-origin top-level navigation gets the app", () => {
    expect(view("same-origin", "navigate", "document")).toBe("app");
  });

  test("everything else gets the warning", () => {
    for (const [site, mode, dest] of [
      ["same-site", "navigate", "document"],
      ["cross-site", "navigate", "document"],
      ["none", "navigate", "document"],
      [undefined, "navigate", "document"],
      ["same-origin", "cors", "document"],
      ["same-origin", undefined, "document"],
      ["same-origin", "navigate", "iframe"],
      ["same-origin", "navigate", "empty"],
      ["same-origin", "navigate", undefined],
      [undefined, undefined, undefined],
    ]) {
      expect(view(site, mode, dest)).toBe("warning");
    }
  });
});

describe("app response headers", () => {
  test("exactly this set", () => {
    expect(appResponseHeaders()).toEqual({
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; manifest-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox allow-scripts allow-modals allow-same-origin",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Resource-Policy": "same-origin",
      "Permissions-Policy":
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=(), display-capture=(), publickey-credentials-get=()",
      "X-Robots-Tag": "noindex, nofollow",
      "Cache-Control": "no-store",
      Vary: "Sec-Fetch-Site, Sec-Fetch-Mode, Sec-Fetch-Dest",
    });
  });

  test("each directive that closes a way out", () => {
    const csp = directives(appResponseHeaders()["Content-Security-Policy"] ?? "");
    for (const name of [
      "default-src",
      "connect-src",
      "form-action",
      "frame-src",
      "child-src",
      "worker-src",
      "manifest-src",
      "object-src",
      "base-uri",
      "frame-ancestors",
    ]) {
      expect([name, csp.get(name)]).toEqual([name, "'none'"]);
    }
    expect(csp.get("sandbox")).toBe("allow-scripts allow-modals allow-same-origin");
  });
});

describe("host pages", () => {
  test("every page is uncached, unindexed, cookie-free and default-src 'none'", () => {
    for (const [name, page] of all) {
      expect([name, page.headers["Cache-Control"]]).toEqual([name, "no-store"]);
      expect(page.headers["X-Robots-Tag"]).toBe("noindex, nofollow");
      expect(page.headers["Content-Type"]).toBe("text/html; charset=utf-8");
      expect(page.headers["X-Content-Type-Options"]).toBe("nosniff");
      expect(page.headers["Referrer-Policy"]).toBe("no-referrer");
      expect(Object.keys(page.headers).map((k) => k.toLowerCase())).not.toContain("set-cookie");
      const csp = directives(page.headers["Content-Security-Policy"] ?? "");
      expect(csp.get("default-src")).toBe("'none'");
      expect(csp.get("base-uri")).toBe("'none'");
      expect(csp.get("frame-ancestors")).toBe("'none'");
      expect(page.body).not.toMatch(/set-cookie|document\.cookie/i);
    }
  });

  test("each CSP hash is the hash of the page's own inline style and script", () => {
    for (const [name, page] of all) {
      const csp = directives(page.headers["Content-Security-Policy"] ?? "");
      const styles = inline(page.body, "style");
      const scripts = inline(page.body, "script");
      expect(styles).toHaveLength(1);
      expect([name, csp.get("style-src")]).toEqual([name, styles.map(hashOf).join(" ")]);
      expect([name, csp.get("script-src")]).toEqual([
        name,
        scripts.length === 0 ? undefined : scripts.map(hashOf).join(" "),
      ]);
      expect(scripts.length).toBe(name === "warning" ? 1 : 0);
      // No inline attribute the CSP would silently block.
      expect(page.body).not.toMatch(/\s(style|onclick|onload|onerror)=/);
    }
  });

  test("form-action 'self' only on the report form", () => {
    for (const [name, page] of all) {
      const csp = directives(page.headers["Content-Security-Policy"] ?? "");
      const isForm = name === "report" || name === "report-empty";
      expect([name, csp.get("form-action")]).toEqual([name, isForm ? "'self'" : "'none'"]);
      expect(page.body.includes("<form")).toBe(isForm);
    }
  });

  test("no external resource and no URL but the configured ones", () => {
    const allowed = [
      "https://apps.example.so/report?app=abcdefghijklmnop",
      `https://${ID}.apps.example.so/`,
      "https://example.so/terms?a=1&amp;b=2",
    ];
    for (const [name, page] of all) {
      for (const url of page.body.match(/\b(?:https?:)?\/\/[^\s"'<>]+/g) ?? []) {
        expect(allowed).toContain(url);
      }
      expect(page.body).not.toMatch(/<(img|link|object|embed)\b|<script\s+src|@import|url\(/);
      // The one iframe is the warning's, and it has no address until its script sets one.
      expect(page.body.includes("<iframe")).toBe(name === "warning");
      expect(page.body).not.toMatch(/<iframe[^>]*\ssrc=/);
    }
  });

  test("the warning says who published it and links the report with the id", () => {
    const { body } = pages.warning(ID);
    expect(body).toContain("published by a tentacle user, not by tentacle");
    expect(body).toContain("does not review it");
    expect(body).toContain("Do not enter passwords or personal data");
    expect(body).toContain(`href="https://apps.example.so/report?app=${ID}"`);
    expect(body).toContain("Continue");
    expect(body).toContain(ESCAPED_EMAIL);
    expect(body).not.toContain(CONFIG.abuseEmail);
  });

  test("every page carries the brand row with the inline mascot, light and dark themes, no network", () => {
    for (const [name, page] of all) {
      expect([name, page.body.includes('<svg class="logo"')]).toEqual([name, true]);
      expect(page.body).toContain("tentacle apps</span>");
      expect(page.body).toContain("prefers-color-scheme: dark");
      expect(page.body).toContain("#5b2a86");
      expect(page.body).toContain("#c9a6f2");
    }
  });

  test("an id that is no id is never interpolated", () => {
    for (const bad of ['"><script>alert(1)</script>', "ABC", ""]) {
      for (const page of [pages.report(bad), pages.warning(bad)]) {
        expect(page.body).not.toContain("alert(1)");
        expect(page.body).not.toContain('value="ABC"');
        expect(page.body).not.toContain("app=ABC");
      }
    }
    expect(pages.report(ID).body).toContain(`value="${ID}"`);
  });

  test("the report form carries the fields the API takes, with their limits", () => {
    const { body } = pages.report(ID);
    expect(body).toContain('method="post" action="/v1/report"');
    for (const value of ["phishing", "malware", "illegal", "other"]) {
      expect(body).toContain(`value="${value}"`);
    }
    expect(body).toMatch(/name="details"[^>]*maxlength="2000"/);
    expect(body).toMatch(/name="contact"[^>]*maxlength="200"/);
    expect(body).toMatch(/name="app"/);
  });

  test("the info page names the abuse address and the terms", () => {
    const { body } = pages.info();
    expect(body).toContain(ESCAPED_EMAIL);
    expect(body).toContain('href="https://example.so/terms?a=1&amp;b=2"');
    expect(pages.reportRefused().body).toContain(ESCAPED_EMAIL);
  });
});

/** Run the warning's own script against a fake browser. */
function browser(
  storage: { local: Map<string, string>; session: Map<string, string> },
  at = 10_000,
) {
  const script = inline(pages.warning(ID).body, "script")[0] ?? "";
  const replaced: string[] = [];
  const elements: Record<
    string,
    { hidden: boolean; click?: () => void; src?: string; focus?: () => void }
  > = {
    continue: { hidden: false, focus: () => {} },
    stuck: { hidden: true },
    "app-frame": { hidden: true, src: "" },
  };
  const store = (map: Map<string, string>) => ({
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => map.set(key, value),
  });
  new Function("localStorage", "sessionStorage", "location", "document", "Date", script)(
    store(storage.local),
    store(storage.session),
    {
      href: `https://${ID}.apps.example.so/?q=1#frag`,
      replace: (url: string) => replaced.push(url),
    },
    {
      getElementById: (name: string) => {
        const element = elements[name];
        return element === undefined
          ? null
          : Object.assign(element, {
              addEventListener: (_type: string, handler: () => void) => {
                element.click = handler;
              },
            });
      },
    },
    { now: () => at },
  );
  return { replaced, elements };
}

describe("the warning's script", () => {
  const fresh = () => ({ local: new Map<string, string>(), session: new Map<string, string>() });
  const target = `https://${ID}.apps.example.so/?q=1`;

  test("waits for Continue, which acknowledges and navigates without the fragment", () => {
    const storage = fresh();
    const page = browser(storage);
    expect(page.replaced).toEqual([]);
    expect(page.elements["app-frame"]?.src).toBe("/_frame");
    expect(page.elements["app-frame"]?.hidden).toBe(false);
    page.elements.continue?.click?.();
    expect(storage.local.get("tentacle-apps-ack")).toBe("1");
    // A URL that differs only by its fragment would not load a new document.
    expect(page.replaced).toEqual([target]);
  });

  test("once acknowledged it forwards by itself, but not twice within 3 s", () => {
    const storage = fresh();
    storage.local.set("tentacle-apps-ack", "1");
    const acked = browser(storage, 10_000);
    expect(acked.replaced).toEqual([target]);
    // Acknowledged: the app is never loaded in the frame.
    expect(acked.elements["app-frame"]?.src).toBe("");
    const again = browser(storage, 12_999);
    expect(again.replaced).toEqual([]);
    expect(again.elements.stuck?.hidden).toBe(false);
    expect(browser(storage, 13_001).replaced).toEqual([target]);
  });

  test("Continue in a browser without Fetch Metadata ends on the explanation", () => {
    const storage = fresh();
    browser(storage, 10_000).elements.continue?.click?.();
    const back = browser(storage, 10_500);
    expect(back.replaced).toEqual([]);
    expect(back.elements.stuck?.hidden).toBe(false);
  });
});

describe("the warning wrapper", () => {
  const { body, headers } = pages.warning(ID);

  test("the app sits in an inert sandbox with scripts only, behind a dialog", () => {
    const frame = /<iframe\b[^>]*>/.exec(body)?.[0] ?? "";
    expect(frame).toContain('sandbox="allow-scripts"');
    expect(frame).not.toMatch(/allow-(same-origin|top-navigation|popups|forms|modals)/);
    expect(frame).toMatch(/\sinert\b/);
    expect(body).toContain('role="dialog" aria-modal="true"');
    expect(body.indexOf("<iframe")).toBeLessThan(body.indexOf('class="overlay"'));
    expect(body).toContain("pointer-events: none");
  });

  test("its CSP frames this origin only; nothing frames it", () => {
    const csp = directives(headers["Content-Security-Policy"] ?? "");
    expect(csp.get("frame-src")).toBe("'self'");
    expect(csp.get("frame-ancestors")).toBe("'none'");
    for (const [name, page] of all) {
      if (name === "warning") continue;
      expect(directives(page.headers["Content-Security-Policy"] ?? "").has("frame-src")).toBe(
        false,
      );
    }
  });

  test("the framed app answers only an iframe navigation of this origin", () => {
    const h = (site: string, mode: string, dest: string) =>
      isFrameRequest(
        new Headers({ "sec-fetch-site": site, "sec-fetch-mode": mode, "sec-fetch-dest": dest }),
      );
    expect(h("same-origin", "navigate", "iframe")).toBe(true);
    for (const [site, mode, dest] of [
      ["same-origin", "navigate", "document"],
      ["cross-site", "navigate", "iframe"],
      ["same-site", "navigate", "iframe"],
      ["none", "navigate", "iframe"],
      ["same-origin", "no-cors", "iframe"],
      ["same-origin", "navigate", "frame"],
    ] as const) {
      expect(h(site, mode, dest)).toBe(false);
    }
    expect(isFrameRequest(new Headers())).toBe(false);
  });

  test("the framed headers differ from the app's only by who may frame it", () => {
    const app = appResponseHeaders();
    const framed = framedAppResponseHeaders();
    expect(framed["X-Frame-Options"]).toBe("SAMEORIGIN");
    expect(framed["Content-Security-Policy"]).toBe(
      (app["Content-Security-Policy"] ?? "")
        .replace("frame-ancestors 'none'", "frame-ancestors 'self'")
        .replace(/sandbox [^;]*/, "sandbox allow-scripts"),
    );
    // the server-side sandbox alone keeps the framed copy opaque (no allow-same-origin)
    expect(framed["Content-Security-Policy"]).toMatch(/sandbox allow-scripts(;|$)/);
    expect(framed["Content-Security-Policy"]).not.toContain("allow-same-origin");
    expect(framed["Content-Security-Policy"]).toContain("sandbox allow-scripts");
    for (const [name, value] of Object.entries(app)) {
      if (name !== "Content-Security-Policy") expect([name, framed[name]]).toEqual([name, value]);
    }
  });
});

describe("the warning's QR code", () => {
  const CANONICAL = `https://${ID}.apps.example.so/`;

  /** Read the module grid back out of the rendered SVG path. */
  function matrixOf(body: string): boolean[][] {
    const svg = /<svg class="qr-code" viewBox="0 0 (\d+) \d+"[\s\S]*?<path d="([^"]*)"/.exec(body);
    const size = Number(svg?.[1]);
    const grid = Array.from({ length: size }, () => new Array<boolean>(size).fill(false));
    for (const m of (svg?.[2] ?? "").matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
      for (let i = 0; i < Number(m[3]); i++) {
        const row = grid[Number(m[2])];
        if (row) row[Number(m[1]) + i] = true;
      }
    }
    return grid.slice(4, size - 4).map((row) => row.slice(4, size - 4));
  }

  test("is an inline svg whose modules are exactly the canonical url's encoding", () => {
    const { body } = pages.warning(ID);
    expect(body).toContain("Open on your phone");
    expect(body).toContain(`<p class="qr-url">${CANONICAL}</p>`);
    expect(matrixOf(body)).toEqual(encode(CANONICAL, { ecc: "M", border: 0 }).data);
    expect(matrixOf(body)).not.toEqual(
      encode("https://other.apps.example.so/", { ecc: "M", border: 0 }).data,
    );
  });

  test("stays dark on a light square in both themes", () => {
    const { body } = pages.warning(ID);
    expect(body).toContain('<rect width="');
    expect(body).toContain('fill="#ffffff"');
    expect(body).toContain('fill="#000000"');
    const svg = body.split('<svg class="qr-code"')[1]?.split("</svg>")[0] ?? "";
    expect(svg).not.toMatch(/currentColor|var\(--/);
  });

  test("is absent from every other page and from an invalid id's warning", () => {
    for (const [name, page] of all) {
      if (name === "warning") continue;
      expect([name, page.body.includes('<svg class="qr-code"')]).toEqual([name, false]);
    }
    expect(pages.warning("ABC").body).not.toContain('<svg class="qr-code"');
  });

  test("a media query hides it on narrow screens", () => {
    const style = inline(pages.warning(ID).body, "style")[0] ?? "";
    expect(style).toMatch(/\.qr \{ display: none; \}/);
    expect(style).toMatch(/@media \(min-width: 700px\) \{\s*\.qr \{ display: block;/);
  });

  test("the encoded url comes from the id and the domain, not from the request", () => {
    // The page factory takes no request input; a different id or domain is the only way in.
    const other = createPages({ ...CONFIG, domain: "apps.other.so" }).warning(ID).body;
    expect(matrixOf(other)).toEqual(
      encode(`https://${ID}.apps.other.so/`, { ecc: "M", border: 0 }).data,
    );
    expect(pages.warning(ID).body).toBe(pages.warning(ID).body);
  });
});
