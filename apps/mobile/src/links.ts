/**
 * Links in a transcript are DATA (plan F22, Owner Q7): text a model produced on
 * another machine, shown to a person who did not ask for it. So a tap never
 * opens anything directly — it shows the FULL url first (the row may show a
 * short label, and the URL may be a `javascript:`/custom scheme) and opens it
 * only after an explicit confirmation.
 *
 * Pure and injected: the confirmation UI and the OS open are seams, so the rule
 * is tested without a simulator.
 */

/** The confirmation a link tap shows, before anything is opened. */
export interface LinkPrompt {
  readonly title: string;
  /** The whole URL, verbatim — never the row's short label. */
  readonly message: string;
  readonly cancel: string;
  readonly confirm: string;
}

/** Only these schemes may be handed to the OS. Everything else is refused. */
const OPENABLE = ["http:", "https:", "mailto:"];

/** Whether `href` is a URL a person could be asked about at all. */
export function openableUrl(href: string): boolean {
  try {
    return OPENABLE.includes(new URL(href).protocol);
  } catch {
    return false;
  }
}

/** What a tap on a link shows (null: not a URL this app will offer to open). */
export function linkPrompt(href: string): LinkPrompt | null {
  if (!openableUrl(href)) {
    return null;
  }
  return {
    title: "Open this link?",
    message: href,
    cancel: "Cancel",
    confirm: "Open",
  };
}

export interface LinkDeps {
  /** Show the confirmation; `onConfirm` runs only on the person's Open. */
  readonly confirm: (prompt: LinkPrompt, onConfirm: () => void) => void;
  /** Hand the URL to the OS (Safari and friends). */
  /** Hand the URL to the OS. Any return (a promise, a void) is ignored. */
  readonly open: (href: string) => unknown;
}

/**
 * A tap on `href`: confirm, then open — or do nothing (an unopenable scheme is
 * silently not offered; its text stays readable in the row either way).
 */
export function tapLink(href: string, deps: LinkDeps): void {
  const prompt = linkPrompt(href);
  if (prompt === null) {
    return;
  }
  deps.confirm(prompt, () => {
    deps.open(href);
  });
}
