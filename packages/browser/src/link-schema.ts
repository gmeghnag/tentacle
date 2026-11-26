// The hub protocol between a tentacle daemon and the browser host (hub). It is
// NOT @tentacle/protocol and never moves PROTOCOL_VERSION: no peer outside this
// Mac speaks it (docs/feat/browser-inspect.md §1).
import { z } from "zod";

export const BROWSER_LINK_VERSION = 1;

/** Cap of one hub line (ByteFramer maxLineBytes): ≥ Chrome's 64 MiB + framing. */
export const HUB_MAX_LINE_BYTES = 80 * 1024 * 1024;

/** Chrome refuses a host → extension message above 1 MB (F4). */
export const HOST_TO_CHROME_MAX_BYTES = 1024 * 1024;

/**
 * The native-messaging host name (F2: lowercase alnum / `_` / `.`) and the
 * key-pinned extension id: the id the manifest `key` yields (U7), i.e. the
 * unpacked copy `tentacle browser install` writes (pinned by
 * `apps/browser-extension/test/manifest.test.ts`).
 */
export const BROWSER_HOST_NAME = "so.tentacle.browser";
export const BROWSER_EXTENSION_ID = "kkhicjoemmpaaaepoaeenijabpeamcog";
/**
 * The Chrome Web Store id (docs/feat/browser-extension-store.md). The store
 * zip ships WITHOUT the `key`, so the store assigns its own id at the first
 * upload. PLACEHOLDER until then: `undefined` = no store copy exists yet.
 * After the first upload, paste the dashboard's «Item ID» (32 letters a–p)
 * here, e.g. `= "abcdefghijklmnopabcdefghijklmnop"`; the native host then
 * accepts both copies (`browserExtensionIds`).
 */
export const BROWSER_EXTENSION_STORE_ID: string | undefined = undefined;

/** Chrome's extension id: 32 letters in a–p (a sha256 prefix, one letter per nibble). */
export function isExtensionId(id: string): boolean {
  return /^[a-p]{32}$/.test(id);
}

/**
 * Every extension id the native host serves: the dev (key-pinned) id first,
 * then the store id when one is set. A malformed store id THROWS — a silent
 * drop would leave the store copy unable to reach the host with no clue why.
 */
export function browserExtensionIds(
  storeId: string | undefined = BROWSER_EXTENSION_STORE_ID,
): string[] {
  if (storeId === undefined || storeId === BROWSER_EXTENSION_ID) return [BROWSER_EXTENSION_ID];
  if (!isExtensionId(storeId)) {
    throw new Error(
      `BROWSER_EXTENSION_STORE_ID is not a Chrome extension id (32 letters a–p): ${storeId}`,
    );
  }
  return [BROWSER_EXTENSION_ID, storeId];
}
/** No hub to dial: Chrome is closed, or the extension is off (the tools' cue to launch it, Q6). */
export const NO_EXTENSION_MESSAGE = "Chrome isn't running with the tentacle extension";
/** The hidden subcommand Chrome's wrapper runs (pinned by a `main` dispatch test). */
export const BROWSER_HOST_SUBCOMMAND = "__browser-host";

export const TabId = z.number().int().nonnegative();

/** The most ring entries one `net list` returns. */
export const NET_PAGE_MAX = 500;

export const ClaimedBy = z.object({
  daemonId: z.string().min(1),
  sessionUid: z.string().min(1),
});
export type ClaimedBy = z.infer<typeof ClaimedBy>;

/** The facts the extension reports about an element before acting (§5). */
export const ElementFacts = z.object({
  tag: z.string(),
  type: z.string().optional(),
  autocomplete: z.string().optional(),
  name: z.string().optional(),
  href: z.string().optional(),
  isContentEditable: z.boolean().optional(),
  inForm: z.boolean().optional(),
  /** The click would submit its enclosing form. */
  submits: z.boolean().optional(),
  formMethod: z.string().optional(),
  formAction: z.string().optional(),
});
export type ElementFacts = z.infer<typeof ElementFacts>;

export const HubHello = z.object({
  version: z.literal(BROWSER_LINK_VERSION),
  daemonId: z.string().min(1),
});

/** Operations a daemon sends to the hub. */
export const HubOp = z.discriminatedUnion("op", [
  z.object({ op: z.literal("claim"), sessionUid: z.string(), title: z.string() }),
  z.object({ op: z.literal("release"), sessionUid: z.string() }),
  /** The session's title changed: its tab group follows (B5b; additive, the link version stays). */
  z.object({ op: z.literal("retitle"), sessionUid: z.string(), title: z.string().max(200) }),
  z.object({ op: z.literal("tabs"), sessionUid: z.string() }),
  z.object({
    op: z.literal("open"),
    sessionUid: z.string(),
    url: z.string(),
    tab: TabId.optional(),
  }),
  z.object({
    op: z.literal("read"),
    sessionUid: z.string(),
    tab: TabId,
    mode: z.enum(["text", "outline", "html"]),
    selector: z.string().optional(),
    maxChars: z.number().int().positive().optional(),
  }),
  z.object({
    op: z.literal("click"),
    sessionUid: z.string(),
    tab: TabId,
    ref: z.string().optional(),
    x: z.number().optional(),
    y: z.number().optional(),
    /** Resolve the target and report its facts WITHOUT acting (the classifier runs first, §5). */
    probe: z.boolean().optional(),
    /** The act: the probe's facts the user approved; the page refuses if the target no longer matches. */
    expect: ElementFacts.optional(),
  }),
  /**
   * `start`/`stop` reach the extension (debugger on/off); `list`/`get` are
   * answered by the HUB from its per-tab ring (§failure modes «WS / SSE
   * floods»): a traced entry is pulled by its owner, never pushed (D1).
   */
  z.object({
    op: z.literal("net"),
    sessionUid: z.string(),
    tab: TabId,
    action: z.enum(["start", "stop", "list", "get"]),
    cursor: z.number().int().nonnegative().optional(),
    limit: z.number().int().positive().max(NET_PAGE_MAX).optional(),
    seq: z.number().int().nonnegative().optional(),
  }),
  /** One response body through the debugger (`Network.getResponseBody`, full tier only). */
  z.object({
    op: z.literal("body"),
    sessionUid: z.string(),
    tab: TabId,
    requestId: z.string().min(1).max(200),
  }),
  /** A screenshot (visible tab: no debugger; background tab: the debugger), long edge ≤ `maxEdge`. */
  z.object({
    op: z.literal("shot"),
    sessionUid: z.string(),
    tab: TabId,
    maxEdge: z.number().int().positive().max(8000).optional(),
  }),
  /** The page's console + JS errors since `cursor` (a bounded ring in the page). */
  z.object({
    op: z.literal("console"),
    sessionUid: z.string(),
    tab: TabId,
    cursor: z.number().int().nonnegative().optional(),
  }),
  /** Close an own tab; a handed-over one is released back to the user, never closed (B5). */
  z.object({ op: z.literal("close"), sessionUid: z.string(), tab: TabId }),
  z.object({
    op: z.literal("type"),
    sessionUid: z.string(),
    tab: TabId,
    ref: z.string(),
    text: z.string().max(64 * 1024),
    submit: z.boolean().optional(),
    probe: z.boolean().optional(),
    expect: ElementFacts.optional(),
  }),
]);
export type HubOp = z.infer<typeof HubOp>;

/** Events the hub pushes to a daemon. */
export const HubEvent = z.discriminatedUnion("event", [
  z.object({ event: z.literal("tab_closed"), tab: TabId }),
  z.object({
    event: z.literal("detached"),
    tab: TabId,
    reason: z.enum(["canceled_by_user", "target_closed", "other"]),
  }),
  z.object({ event: z.literal("chrome_closed") }),
]);
export type HubEvent = z.infer<typeof HubEvent>;

/**
 * One traced request / WS message, extension → hub (`tier`: headers-only
 * webRequest, or full CDP). Kept in the hub's per-tab ring and NEVER
 * broadcast: it carries page data, so only the tab's owner pulls it (D1).
 */
export const NetEvent = z.object({
  event: z.literal("net"),
  tab: TabId,
  tier: z.enum(["headers", "full"]),
  entry: z.record(z.unknown()),
});
export type NetEvent = z.infer<typeof NetEvent>;

/** One ring entry as `net list` / `net get` return it. */
export interface NetRecord {
  readonly seq: number;
  readonly tier: "headers" | "full";
  readonly entry: Record<string, unknown>;
}
