// Consequential-action classifier (docs/feat/browser-inspect.md §5). Pure: the
// extension reports FACTS, this decides. `hard` asks survive the session's
// `browser.actions: auto` switch (payment click, password/card typing).
import type { ElementFacts } from "./link-schema.ts";

const DESTRUCTIVE = [
  "delete",
  "remove",
  "pay",
  "buy",
  "order",
  "confirm",
  "send",
  "transfer",
  "publish",
  "unsubscribe",
  "purchase",
  "checkout",
  "elimina",
  "rimuovi",
  "paga",
  "acquista",
  "ordina",
  "conferma",
  "invia",
  "trasferisci",
  "pubblica",
  "annulla iscrizione",
];
const PAYMENT = [
  "pay",
  "buy",
  "order",
  "purchase",
  "checkout",
  "transfer",
  "paga",
  "acquista",
  "ordina",
  "trasferisci",
];

function lexiconRe(words: string[]): RegExp {
  const alt = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alt})(?![\\p{L}\\p{N}])`, "iu");
}
const DESTRUCTIVE_RE = lexiconRe(DESTRUCTIVE);
const PAYMENT_RE = lexiconRe(PAYMENT);

// Registrable-domain (eTLD+1) without a PSL dependency: the common two-label
// public suffixes; everything else is the last two labels.
const TWO_LABEL_SUFFIX = new Set([
  "co.uk",
  "org.uk",
  "ac.uk",
  "gov.uk",
  "me.uk",
  "com.au",
  "net.au",
  "org.au",
  "co.nz",
  "co.jp",
  "ne.jp",
  "or.jp",
  "com.br",
  "com.ar",
  "com.mx",
  "co.in",
  "co.za",
  "com.cn",
  "com.tr",
  "com.sg",
  "com.hk",
  "co.kr",
  "com.tw",
  "co.il",
]);

export function registrableDomain(hostOrUrl: string): string {
  let host = hostOrUrl;
  if (host.includes("://")) {
    try {
      host = new URL(host).hostname;
    } catch {
      return "";
    }
  }
  host = host.toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return host;
  const labels = host.split(".");
  if (labels.length <= 2) return host;
  const last2 = labels.slice(-2).join(".");
  return TWO_LABEL_SUFFIX.has(last2) ? labels.slice(-3).join(".") : last2;
}

export type ActionInput = {
  kind: "click" | "type" | "open";
  facts?: ElementFacts;
  /** `browser_type{submit:true}` */
  submit?: boolean;
  /** `browser_open` URL (or a redirect target). */
  targetUrl?: string;
  /** eTLD+1s this session's group has visited. */
  visited: ReadonlySet<string>;
  /** The tab was handed over by the user and not yet acted on. */
  firstOnHandedOver?: boolean;
};

export type ActionVerdict = { ask: boolean; hard: boolean; reasons: string[] };

export function isSensitiveField(f: ElementFacts | undefined): boolean {
  if (!f) return false;
  const ac = (f.autocomplete ?? "").toLowerCase();
  return (
    (f.type ?? "").toLowerCase() === "password" ||
    ac.startsWith("cc-") ||
    ac.includes("one-time-code")
  );
}

export function classifyAction(a: ActionInput): ActionVerdict {
  const reasons: string[] = [];
  let hard = false;
  const f = a.facts;
  const name = f?.name ?? "";

  if (a.kind === "type" && isSensitiveField(f)) {
    reasons.push("typing into a password / payment field");
    hard = true;
  }
  if (a.kind === "type" && a.submit) reasons.push("submits a form");
  if (a.kind === "click") {
    if (f?.submits) reasons.push("submits a form");
    if (DESTRUCTIVE_RE.test(name)) {
      reasons.push(`control named “${name}” (destructive / payment wording)`);
      if (PAYMENT_RE.test(name)) hard = true;
    }
  }
  // Where the action navigates: the URL opened, a link's href, or — when it
  // submits — its form's action (the classic exfiltration post, §4 layer 4).
  const submits = (a.kind === "click" && f?.submits === true) || (a.kind === "type" && a.submit);
  const targets = [a.kind === "open" ? a.targetUrl : f?.href, submits ? f?.formAction : undefined];
  for (const target of new Set(targets.map((t) => (t ? registrableDomain(t) : "")))) {
    if (target && !a.visited.has(target)) reasons.push(`navigates to a new domain (${target})`);
  }
  if (a.firstOnHandedOver) reasons.push("first action on a tab the user handed over");

  return { ask: reasons.length > 0, hard, reasons };
}
