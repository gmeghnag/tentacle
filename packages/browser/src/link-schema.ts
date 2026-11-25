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
 * key-pinned extension id. B3 ships the extension and replaces the id with
 * the one its manifest `key` yields (U7).
 */
export const BROWSER_HOST_NAME = "so.tentacle.browser";
export const BROWSER_EXTENSION_ID = "kkhicjoemmpaaaepoaeenijabpeamcog";
/** The hidden subcommand Chrome's wrapper runs (pinned by a `main` dispatch test). */
export const BROWSER_HOST_SUBCOMMAND = "__browser-host";

export const TabId = z.number().int().nonnegative();

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
  }),
  z.object({
    op: z.literal("net"),
    sessionUid: z.string(),
    tab: TabId,
    action: z.enum(["start", "stop"]),
  }),
  z.object({
    op: z.literal("type"),
    sessionUid: z.string(),
    tab: TabId,
    ref: z.string(),
    text: z.string().max(64 * 1024),
    submit: z.boolean().optional(),
    probe: z.boolean().optional(),
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
  /** One traced request / WS message (`tier`: headers-only webRequest, or full CDP). */
  z.object({
    event: z.literal("net"),
    tab: TabId,
    tier: z.enum(["headers", "full"]),
    entry: z.record(z.unknown()),
  }),
]);
export type HubEvent = z.infer<typeof HubEvent>;
