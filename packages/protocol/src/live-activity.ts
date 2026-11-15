/**
 * The Live Activity wire (docs/feat/mobile-live-activity.md Design 1 + 4, L2):
 * the plaintext a widget shows, the CLEAR `content-state` / `attributes` that
 * wrap its seal, and the three device-principal methods that move tokens.
 *
 * The rules this file exists for:
 *
 *  - **The plaintext carries content, so it is SEALED before it leaves the
 *    computer** (L1's `sealActivity`). A field may therefore hold a project
 *    name, a title, a command preview: the relay and Apple only ever see a
 *    ciphertext (Owner Q2, F5). Nothing here is authority — the widget renders
 *    it, and an ACTION still rides the ONE session path
 *    (`session/resolve_permission`, task 17's coordinator).
 *  - **An activity must fit an APNs payload**, so the plaintext is clipped to a
 *    byte budget ({@link fitActivityContent}), not merely bounded per field. The
 *    worst case at every cap is 1020 bytes — the 1024 bucket — which leaves the
 *    clear fields and Apple's envelope inside 4096 (test: `live-activity.test`).
 *  - **The clear parts carry no content**: {@link ActivityContentStateSchema} is
 *    `{v,e,c}`, the push-to-start {@link ActivityAttributesSchema} is `{v,k,slot}`.
 *  - **`slot` is the activity's identity**: a fresh 96-bit value per activity,
 *    and the AEAD's aad binds a state to it (L1), so a relay cannot move one
 *    session's state into another's activity (F7). It is ALSO what the daemon's
 *    in-memory slot table keys on (Owner Q8).
 *  - **Clipping may never split a character** (no lone surrogate): the widget
 *    decodes with Swift's `JSONDecoder`, which refuses one.
 *
 * Every schema is a STRIP schema (AGENTS §7 forward compatibility): an unknown
 * field is dropped on inbound parse, never rejected — that is what lets a newer
 * daemon talk to an older widget and vice versa (F22).
 *
 * Additive on the wire, no `PROTOCOL_VERSION` bump: an older daemon answers
 * `MethodNotFound`, which the app shows as "update tentacle on <computer>" (F22).
 */
import { z } from "zod";
import { PermissionOptionKindSchema, PermissionRequestIdSchema } from "./permission.ts";
import { line } from "./text-line.ts";

/** The plaintext sizes an activity can have, as the buckets L1 seals to. 2048 is a push's, never an activity's. */
export const ACTIVITY_PAD_BUCKETS = [512, 1024] as const;

/** The `u16` length prefix L1 writes into every bucket (subtracted from the budget here). */
export const ACTIVITY_LENGTH_BYTES = 2;

/** The largest `ActivityContent` plaintext: the last bucket minus its length prefix (1022). */
export const ACTIVITY_PLAINTEXT_MAX_BYTES =
  (ACTIVITY_PAD_BUCKETS[ACTIVITY_PAD_BUCKETS.length - 1] ?? 1024) - ACTIVITY_LENGTH_BYTES;

/** The ChaCha20-Poly1305 tag, so a sealed state is `bucket + 16` bytes. */
export const ACTIVITY_AEAD_TAG_BYTES = 16;

/**
 * The base64url LENGTHS of a sealed content-state — exactly two values on the
 * wire, so the size bucket says only "short" or "at the caps" (Owner Q2). Pinned
 * (not just derived) because a codegen client needs them as a plain constant, and
 * {@link ActivityContentStateSchema} bounds `c` with them, so a truncated or
 * padded one is refused instead of opened.
 */
export const ACTIVITY_ENVELOPE_CIPHERTEXT_LENGTHS: readonly number[] = ACTIVITY_PAD_BUCKETS.map(
  (bucket) => Math.ceil(((bucket + ACTIVITY_AEAD_TAG_BYTES) * 4) / 3),
);

/** A key id's length (L1's `PUSH_KID_LENGTH`): the same 72 bits, so a widget can pick the computer first. */
export const ACTIVITY_KID_LENGTH = 12;
/** `e`: a 32-byte X25519 public key, base64url, unpadded (43 characters). */
export const ACTIVITY_ENC_TEXT_LENGTH = 43;

/**
 * A slot: 96 random bits, hex (24 characters). Long enough that a relay cannot
 * guess one (a guessed slot is useless anyway — the state still will not open
 * without the computer's key), short enough to be visible in a targeted probe.
 */
export const ACTIVITY_SLOT_LENGTH = 24;
const ACTIVITY_SLOT_RE = new RegExp(`^[0-9a-f]{${ACTIVITY_SLOT_LENGTH}}$`);

/**
 * The clip caps, in UTF-8 BYTES. These are chosen so the worst case — every
 * field at its cap, every character 4 bytes — still fits the 1024 bucket
 * ({@link ACTIVITY_PLAINTEXT_MAX_BYTES}); raising one without re-running that
 * test is exactly the mistake this comment is here to prevent.
 */
export const ACTIVITY_COMPUTER_MAX = 64;
export const ACTIVITY_PROJECT_MAX = 120;
export const ACTIVITY_TITLE_MAX = 120;
export const ACTIVITY_TOOL_MAX = 80;
export const ACTIVITY_ASK_TOOL_MAX = 60;
export const ACTIVITY_PREVIEW_MAX = 160;
export const ACTIVITY_ERROR_MAX = 120;
/** A turn id as the app holds it (a UUID, with room for a fork/child suffix). */
export const ACTIVITY_TURN_ID_MAX = 64;
export const ACTIVITY_OPTIONS_MAX = 6;
export const ACTIVITY_OPTION_ID_MAX = 64;
/** `more`: how many further asks are waiting (task 16's folded banner, "+N"). */
export const ACTIVITY_MORE_MAX = 99;

/**
 * The kinds a widget knows how to draw. An UNKNOWN one is refused here (so the
 * daemon never seals one) and rendered as the placeholder by the widget (F22:
 * an older widget against a newer daemon).
 */
export const ACTIVITY_KINDS = ["running", "asking", "done", "failed", "cancelled"] as const;
export const ActivityKindSchema = z.enum(ACTIVITY_KINDS);
export type ActivityKind = z.infer<typeof ActivityKindSchema>;

const encoder = new TextEncoder();

/**
 * The envelope ciphertext's ONE accepted shape: a base64url string whose length
 * is one of the two buckets' encodings (704 / 1387 chars).
 *
 * A regex alternation rather than `.refine()`: the JSON-schema export cannot
 * represent a `ZodEffects`, and this schema is ON the exported wire (the relay's
 * `liveactivity` frame and the APNs `content-state` both carry it).
 */
const ACTIVITY_CIPHERTEXT_RE = new RegExp(
  `^(?:${ACTIVITY_ENVELOPE_CIPHERTEXT_LENGTHS.map((length) => `[A-Za-z0-9_-]{${length}}`).join("|")})$`,
);

/**
 * `true` iff `codePoint` survives a clip. Control characters are dropped by the
 * same rule the wire's `line` enforces, and a lone surrogate is dropped because
 * UTF-8 cannot encode it at all — and Swift's decoder refuses it.
 */
function keepable(codePoint: number): boolean {
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
    return false;
  }
  return !(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
}

/**
 * `text` cut to at most `maxBytes` of UTF-8, walking CODE POINTS so a surrogate
 * pair is never split. The twin of `clipPushText` in `push.ts`: kept separate
 * because the two protocols clip to different budgets and neither may drift
 * with the other.
 */
export function clipActivityText(text: string, maxBytes: number): string {
  if (maxBytes <= 0) {
    return "";
  }
  let out = "";
  let used = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (!keepable(codePoint)) {
      continue;
    }
    const size = encoder.encode(char).length;
    if (used + size > maxBytes) {
      break;
    }
    out += char;
    used += size;
  }
  return out;
}

/** One option a widget may offer as a button: `allow_once` / `reject_once` only (Owner Q6 — never `allow_always`). */
export const ActivityAskOptionSchema = z.object({
  optionId: z.string().min(1).max(ACTIVITY_OPTION_ID_MAX),
  /** The option's kind, so the render spec can pick Approve vs Deny without the app's option table. */
  kind: PermissionOptionKindSchema,
});
export type ActivityAskOption = z.infer<typeof ActivityAskOptionSchema>;

/**
 * What is waiting, when `kind` is `asking`. `requestId` is the ONE field an
 * answer derives from (L11 re-opens the state and reads it here; a widget's
 * button only names the activity, never the request), which is why it is the
 * last thing the clip ladder gives up.
 */
export const ActivityAskSchema = z.object({
  requestId: PermissionRequestIdSchema,
  tool: line(ACTIVITY_ASK_TOOL_MAX),
  preview: z.string().max(ACTIVITY_PREVIEW_MAX),
  options: z.array(ActivityAskOptionSchema).min(1).max(ACTIVITY_OPTIONS_MAX),
});
export type ActivityAsk = z.infer<typeof ActivityAskSchema>;

/**
 * What the widget draws, sealed end-to-end. `startedAt` is the turn's ORIGINAL
 * start, not this activity's: the elapsed timer is drawn on the phone
 * (`Text(timerInterval:)`) so it costs no updates, and an 8 h rollover (a
 * continuation activity) must not restart it (Design 3, F18).
 */
export const ActivityContentSchema = z.object({
  v: z.literal(1),
  slot: z.string().regex(ACTIVITY_SLOT_RE),
  /** Monotonic per slot, so a widget can ignore a state that arrives out of order. */
  seq: z.number().int().min(0),
  /** When the daemon produced this state (ms). Display only — a relay may rewrite it (F8). */
  at: z.number().int().min(0),
  kind: ActivityKindSchema,
  computer: line(ACTIVITY_COMPUTER_MAX),
  /** The basename of the session's `cwd`: what a lock screen may show (Owner Q7). */
  project: line(ACTIVITY_PROJECT_MAX),
  title: line(ACTIVITY_TITLE_MAX),
  turnId: z.string().min(1).max(ACTIVITY_TURN_ID_MAX),
  startedAt: z.number().int().min(0),
  tool: line(ACTIVITY_TOOL_MAX).optional(),
  ask: ActivityAskSchema.optional(),
  error: line(ACTIVITY_ERROR_MAX).optional(),
  more: z.number().int().min(1).max(ACTIVITY_MORE_MAX).optional(),
});
export type ActivityContent = z.infer<typeof ActivityContentSchema>;

/**
 * The CLEAR `aps.content-state`: the sealed blob and nothing else. `e` is the
 * ephemeral public key and `c` the ciphertext, both base64url — the exact shape
 * L1's `SealedPush` encodes to. A field a peer adds is STRIPPED here: the clear
 * part is not a place for content (Owner Q2).
 */
export const ActivityContentStateSchema = z.object({
  v: z.literal(1),
  e: z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${ACTIVITY_ENC_TEXT_LENGTH}}$`)),
  c: z.string().regex(ACTIVITY_CIPHERTEXT_RE),
});
export type ActivityContentState = z.infer<typeof ActivityContentStateSchema>;

/**
 * The CLEAR `attributes` of a push-to-start. Apple requires them because a
 * push-started activity has no activity to inherit them from; they must match
 * the widget's `TentacleActivityAttributes` type. `k` (the kid) lets the widget
 * pick the pinned computer and is the aad's first half; `slot` is the second.
 * No content: that is the whole point (F6 — a hostile relay can junk-start a
 * placeholder, and it shows the placeholder).
 */
export const ActivityAttributesSchema = z.object({
  v: z.literal(1),
  k: z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${ACTIVITY_KID_LENGTH}}$`)),
  slot: z.string().regex(ACTIVITY_SLOT_RE),
});
export type ActivityAttributes = z.infer<typeof ActivityAttributesSchema>;

/** `true` iff `value` is a slot this protocol would accept (used by the daemon's slot table). */
export function isActivitySlot(value: unknown): value is string {
  return typeof value === "string" && ACTIVITY_SLOT_RE.test(value);
}

/**
 * A fresh 96-bit slot, hex. `crypto.getRandomValues` is the platform's CSPRNG
 * (Bun and React Native both provide it), so the daemon needs nothing injected:
 * a slot is not a secret, it is an unguessable NAME, and the seal is what keeps
 * it from being a capability.
 */
export function newActivitySlot(): string {
  const bytes = new Uint8Array(ACTIVITY_SLOT_LENGTH / 2);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, "0");
  }
  return out;
}

/**
 * How hard {@link fitActivityContent} may shrink the plaintext, in the order it
 * gives way. What carries the least goes first (the command preview), and the
 * identity — `slot`, `turnId`, `startedAt` — is NEVER touched: a widget that
 * cannot name its turn cannot be acted on, and the elapsed timer must not jump.
 */
const ACTIVITY_LADDER: readonly ((content: ActivityContent) => ActivityContent)[] = [
  // 1. The preview is the first thing to go.
  (c) => (c.ask === undefined ? c : { ...c, ask: { ...c.ask, preview: "" } }),
  // 2. The error detail, then the tool line.
  (c) => ({ ...c, error: c.error === undefined ? undefined : clipActivityText(c.error, 60) }),
  (c) => ({ ...c, tool: c.tool === undefined ? undefined : clipActivityText(c.tool, 40) }),
  // 3. The long free text: title and project.
  (c) => ({
    ...c,
    title: clipActivityText(c.title, 60),
    project: clipActivityText(c.project, 60),
  }),
  // 4. The ask's own text, and its options down to the two the buttons need.
  (c) =>
    c.ask === undefined
      ? c
      : {
          ...c,
          ask: {
            ...c.ask,
            tool: clipActivityText(c.ask.tool, 30),
            options: c.ask.options.slice(0, 2),
          },
        },
  // 5. The last resort: titles and names to a readable stub.
  (c) => ({
    ...c,
    title: clipActivityText(c.title, 24),
    project: clipActivityText(c.project, 24),
    computer: clipActivityText(c.computer, 24),
    tool: c.tool === undefined ? undefined : clipActivityText(c.tool, 20),
  }),
];

/** The UTF-8 length of `content` as JSON — the number the bucket ladder is measured in. */
function activityBytesOf(content: ActivityContent): number {
  return encoder.encode(JSON.stringify(content)).length;
}

/**
 * Clip every bounded field to its OWN cap first. {@link fitActivityContent}
 * starts here, so its output always satisfies {@link ActivityContentSchema}:
 * cutting for the byte budget alone could leave a field over its schema cap
 * (a 200-emoji title fits 1022 bytes but not `title`'s own 120-byte line), and a
 * widget validates what it opens. Cheap, and it makes the invariant airtight.
 */
function clipToCaps(content: ActivityContent): ActivityContent {
  return {
    ...content,
    computer: clipActivityText(content.computer, ACTIVITY_COMPUTER_MAX),
    project: clipActivityText(content.project, ACTIVITY_PROJECT_MAX),
    title: clipActivityText(content.title, ACTIVITY_TITLE_MAX),
    tool:
      content.tool === undefined ? undefined : clipActivityText(content.tool, ACTIVITY_TOOL_MAX),
    error:
      content.error === undefined ? undefined : clipActivityText(content.error, ACTIVITY_ERROR_MAX),
    ask:
      content.ask === undefined
        ? undefined
        : {
            ...content.ask,
            tool: clipActivityText(content.ask.tool, ACTIVITY_ASK_TOOL_MAX),
            preview: clipActivityText(content.ask.preview, ACTIVITY_PREVIEW_MAX),
          },
  };
}

/**
 * Clip `content` until it fits {@link ACTIVITY_PLAINTEXT_MAX_BYTES}. The one
 * producer-side gate: L7 seals only this function's output, so an activity can
 * never outgrow its bucket — and a field added later cannot silently break that
 * (the budget test would fail).
 *
 * Returns the content UNCHANGED when it already fits, so a normal state is not
 * gratuitously clipped (and its bytes stay stable, which the vectors pin).
 */
export function fitActivityContent(content: ActivityContent): ActivityContent {
  let current = clipToCaps(content);
  if (activityBytesOf(current) <= ACTIVITY_PLAINTEXT_MAX_BYTES) {
    return current;
  }
  for (const step of ACTIVITY_LADDER) {
    current = step(current);
    if (activityBytesOf(current) <= ACTIVITY_PLAINTEXT_MAX_BYTES) {
      return current;
    }
  }
  // Every text field is already a stub at this point, so this cannot happen with
  // a schema-valid input — but throwing beats sealing a state that will not fit
  // its bucket (a seal would throw `too-large` anyway, with a worse message).
  throw new Error(
    `an ActivityContent must fit ${ACTIVITY_PLAINTEXT_MAX_BYTES} bytes even after clipping`,
  );
}

/**
 * Why an activity will or will not appear, so Settings can say it honestly:
 * `on`, `off` (the person switched Live Activities off, or `liveActivity.enabled`
 * is false), `relay-off` (this computer talks to no relay), `relay-no-la` (its
 * relay has no APNs key — F4) and `unsupported` (iPad, or `areActivitiesEnabled`
 * is false — F24).
 */
export const LIVE_ACTIVITY_STATUSES = [
  "on",
  "off",
  "relay-off",
  "relay-no-la",
  "unsupported",
] as const;
export const LiveActivityStatusSchema = z.enum(LIVE_ACTIVITY_STATUSES);
export type LiveActivityStatus = z.infer<typeof LiveActivityStatusSchema>;

/** `device/live_activity_register`: the push-to-start token, its APNs env, and the on/off switch. */
export const DeviceLiveActivityRegisterParamsSchema = z.object({
  /** The hex push-to-start token (APNs tokens are 32+ bytes; `device/push_register`'s rule). */
  startToken: z.string().regex(/^[0-9a-f]{64,200}$/),
  env: z.enum(["sandbox", "production"]),
  enabled: z.boolean(),
});
export type DeviceLiveActivityRegisterParams = z.infer<
  typeof DeviceLiveActivityRegisterParamsSchema
>;

/** `device/live_activity_register`'s result: why it will or will not appear. */
export const DeviceLiveActivityRegisterResultSchema = z.object({
  status: LiveActivityStatusSchema,
});
export type DeviceLiveActivityRegisterResult = z.infer<
  typeof DeviceLiveActivityRegisterResultSchema
>;

/**
 * `device/live_activity_token`: the per-activity UPDATE token. The daemon keys it
 * on `slot`, which is why a slot it never issued is `known:false` rather than an
 * error (F25) — and why a hostile app cannot name an activity into existence.
 */
export const DeviceLiveActivityTokenParamsSchema = z.object({
  slot: z.string().regex(ACTIVITY_SLOT_RE),
  token: z.string().regex(/^[0-9a-f]{64,200}$/),
});
export type DeviceLiveActivityTokenParams = z.infer<typeof DeviceLiveActivityTokenParamsSchema>;

/** `device/live_activity_token`'s result: whether this daemon started that activity. */
export const DeviceLiveActivityTokenResultSchema = z.object({ known: z.boolean() });
export type DeviceLiveActivityTokenResult = z.infer<typeof DeviceLiveActivityTokenResultSchema>;

/**
 * `device/live_activity_ended`: the app reports an activity's end so it is never
 * restarted for that turn (F17). `dismissed` is the person's gesture, `ended` a
 * clean end the daemon did not see (a reconcile), `stale` an activity whose
 * content no longer opens.
 */
export const LIVE_ACTIVITY_END_REASONS = ["dismissed", "ended", "stale"] as const;
export const LiveActivityEndReasonSchema = z.enum(LIVE_ACTIVITY_END_REASONS);
export type LiveActivityEndReason = z.infer<typeof LiveActivityEndReasonSchema>;

export const DeviceLiveActivityEndedParamsSchema = z.object({
  slot: z.string().regex(ACTIVITY_SLOT_RE),
  reason: LiveActivityEndReasonSchema,
});
export type DeviceLiveActivityEndedParams = z.infer<typeof DeviceLiveActivityEndedParamsSchema>;

/** `device/live_activity_ended`'s result: nothing to say. */
export const DeviceLiveActivityEndedResultSchema = z.object({});
export type DeviceLiveActivityEndedResult = z.infer<typeof DeviceLiveActivityEndedResultSchema>;
