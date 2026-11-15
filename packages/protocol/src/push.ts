/**
 * The push wire (docs/feat/mobile-push.md Design 3, slice P2): the sealed
 * plaintext a phone shows, the envelope the relay carries, and the two device
 * methods that register a token.
 *
 * Three rules govern this file.
 *
 *  - **Everything here is SEALED before it leaves the computer** (P1's
 *    `sealPush`). So a field may carry real content — a session title, a
 *    command's preview — exactly because the relay and Apple only ever see a
 *    ciphertext. Nothing here is authority: the app renders it, and the ACTION
 *    (Approve/Deny) still goes over Noise as `session/resolve_permission`
 *    (AGENTS §7, one session path).
 *  - **A push must fit an APNs payload, so the plaintext is CLIPPED to a byte
 *    budget, not merely bounded per field** ({@link fitPushMessage}). A schema
 *    cap alone does not bound the total: `cwd` at its 4096 cap is already 8 KiB
 *    of UTF-8. `fitPushMessage` is the one producer-side gate, and P7 seals only
 *    its output.
 *  - **Clipping may never produce something undecodable** — no split surrogate
 *    pair, no lone surrogate, no control character: the extension decodes this
 *    with Swift's JSON decoder, and `JSON.stringify` would happily emit an
 *    escaped lone surrogate that Swift refuses (or worse, that a notification
 *    centre renders as a replacement glyph).
 *
 * Additive on the wire, no `PROTOCOL_VERSION` bump (AGENTS §7): an older daemon
 * answers `MethodNotFound`, which the app shows as "update tentacle on
 * <computer>" (F16).
 */
import { z } from "zod";
import { PermissionOptionKindSchema, PermissionRequestIdSchema } from "./permission.ts";
import { line } from "./text-line.ts";

/**
 * The three plaintext sizes a push can have, as the buckets P1 seals to
 * (`packages/transport/src/push-seal.ts`). The size says nothing about the kind:
 * a short `ask` and a `turn_done` are both 512.
 *
 * Declared here rather than imported because the DEPENDENCY runs the other way
 * (transport imports protocol): P1 owns sealing and keeps its own copy, and
 * `push.test.ts` asserts the two agree — the equality that makes the duplication
 * safe is a test, not a comment (`PUSH_PLAINTEXT_MAX_BYTES ===
 * maxPushPlaintextBytes()`).
 */
export const PUSH_PAD_BUCKETS = [512, 1024, 2048] as const;

/** The length prefix P1 writes into every bucket (`u16`), subtracted from the budget here. */
export const PUSH_LENGTH_BYTES = 2;

/** The largest plaintext a push can carry: the last bucket minus its length prefix (2046). */
export const PUSH_PLAINTEXT_MAX_BYTES =
  (PUSH_PAD_BUCKETS[PUSH_PAD_BUCKETS.length - 1] ?? 2048) - PUSH_LENGTH_BYTES;

/** The ChaCha20-Poly1305 tag, so a sealed push is `bucket + 16` bytes. */
export const PUSH_AEAD_TAG_BYTES = 16;

/**
 * The base64url LENGTHS of a sealed ciphertext — 528/1040/2064 bytes, i.e. one
 * of exactly three values on the wire. Pinned (not just derived) because a codegen
 * client needs them as a plain constant, and the envelope schema bounds `c` with
 * them, so a truncated or padded one is refused instead of opened.
 */
export const PUSH_ENVELOPE_CIPHERTEXT_LENGTHS: readonly number[] = PUSH_PAD_BUCKETS.map((bucket) =>
  Math.ceil(((bucket + PUSH_AEAD_TAG_BYTES) * 4) / 3),
);

/** A push key id's length (P1's `PUSH_KID_LENGTH`): 72 bits of the computer key's hash. */
export const PUSH_KID_LENGTH = 12;
/** `enc`: a 32-byte X25519 public key, base64url, unpadded. */
export const PUSH_ENC_TEXT_LENGTH = 43;

/** A computer's display name on a push (the same bound as pairing's). */
export const PUSH_COMPUTER_MAX = 64;
/** The project directory: the app's project key (as in discovery, `daemon.ts`). */
export const PUSH_CWD_MAX = 4096;
/** A session id as the app holds it (a UUID, with room for a fork/child suffix). */
export const PUSH_SESSION_ID_MAX = 128;
/** A push's own title line — what the notification's thread/title shows. */
export const PUSH_TITLE_MAX = 200;
/** An ask's tool name and its title (the tool call's one-line summary), and its preview. */
export const PUSH_TOOL_MAX = 128;
export const PUSH_ASK_TITLE_MAX = 300;
export const PUSH_PREVIEW_MAX = 500;
/** The fewest/most options an ask can offer (a permission request always offers one). */
export const PUSH_OPTIONS_MAX = 8;
export const PUSH_OPTION_ID_MAX = 64;
export const PUSH_OPTION_NAME_MAX = 120;

/** The default grace before an unanswered ask is pushed (Owner Q3); `0` = at once. */
export const DEFAULT_PUSH_GRACE_SECONDS = 30;
/** The range `push.graceSeconds` accepts (`packages/config`, `serve --push-grace`). */
export const PUSH_GRACE_MAX_SECONDS = 3600;

/** The `apns-collapse-id` header's limit, in BYTES (Apple refuses a longer one). */
export const PUSH_COLLAPSE_ID_MAX = 64;

const HEX_128_RE = /^[0-9a-f]{32}$/;
const PUSH_TOKEN_RE = /^[0-9a-f]{64,200}$/;
const PUSH_KEY_RE = new RegExp(`^[A-Za-z0-9_-]{${PUSH_ENC_TEXT_LENGTH}}$`);

const encoder = new TextEncoder();

/**
 * The envelope ciphertext's ONE accepted shape: a base64url string whose length
 * is one of the three buckets' encodings (704/1387/2752 chars).
 *
 * A regex alternation rather than `.refine()`: the JSON-schema export cannot
 * represent a `ZodEffects`, and this schema is ON the exported wire (the relay's
 * `push` frame carries it), so the bound has to be a plain string constraint.
 */
const PUSH_CIPHERTEXT_RE = new RegExp(
  `^(?:${PUSH_ENVELOPE_CIPHERTEXT_LENGTHS.map((length) => `[A-Za-z0-9_-]{${length}}`).join("|")})$`,
);

/**
 * `true` iff `codePoint` survives a clip. Control characters are dropped by the
 * same rule the wire's `line` enforces, and a lone surrogate (a `charCodeAt`
 * half of a pair) is dropped because UTF-8 cannot encode it at all.
 */
function keepable(codePoint: number): boolean {
  if (codePoint >= 0xd800 && codePoint <= 0xdfff) {
    return false;
  }
  return !(codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f));
}

/**
 * `text` cut to at most `maxBytes` of UTF-8, walking CODE POINTS (never UTF-16
 * units) so a surrogate pair is never split, and dropping what UTF-8 cannot
 * carry. May return `""` — the caller decides whether an empty result is allowed.
 */
export function clipPushText(text: string, maxBytes: number): string {
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
    // `char` is one code point, so its UTF-8 length is the same as its code unit count.
    const size = encoder.encode(char).length;
    if (used + size > maxBytes) {
      break;
    }
    out += char;
    used += size;
  }
  return out;
}

/** {@link clipPushText}, but keeps at least one code point: for a field the wire requires non-empty. */
function clipKeep(text: string, maxBytes: number): string {
  const clipped = clipPushText(text, maxBytes);
  if (clipped !== "" || text === "") {
    return clipped;
  }
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    if (keepable(codePoint)) {
      return char;
    }
  }
  return "";
}

/**
 * One option of an ask, mirroring `PermissionOption` — the app can render the
 * sheet from the push alone, but the reply it sends is still
 * `session/resolve_permission` over Noise.
 */
export const PushAskOptionSchema = z.object({
  optionId: line(PUSH_OPTION_ID_MAX),
  kind: PermissionOptionKindSchema,
  name: line(PUSH_OPTION_NAME_MAX),
});
export type PushAskOption = z.infer<typeof PushAskOptionSchema>;

/** The ask a push is about: enough to show it, never enough to answer it. */
export const PushAskSchema = z.object({
  requestId: PermissionRequestIdSchema,
  tool: line(PUSH_TOOL_MAX),
  title: line(PUSH_ASK_TITLE_MAX),
  /** The command's first line (docs/feat/permission-events.md's preview), clipped by `fitPushMessage`. */
  preview: line(PUSH_PREVIEW_MAX).optional(),
  options: z.array(PushAskOptionSchema).min(1).max(PUSH_OPTIONS_MAX),
  /** The daemon accepts a refusal with a reply, up to `maxChars` (as the update says). */
  reply: z.object({ maxChars: z.number().int().min(1).max(100_000) }).optional(),
  /** "+N more waiting": asks folded into this one by the rate cap (Design 1). */
  more: z.number().int().min(0).max(999).optional(),
});
export type PushAsk = z.infer<typeof PushAskSchema>;

/** The turn a push is about. */
export const PushTurnSchema = z.object({
  turnId: line(PUSH_SESSION_ID_MAX),
  /** Why it failed, for kind `turn_failed` (the app shows one line). */
  error: line(PUSH_ASK_TITLE_MAX).optional(),
});
export type PushTurn = z.infer<typeof PushTurnSchema>;

/** The push kinds: an ask, its replacement, and the two ways a turn ends that are worth a buzz. */
export const PUSH_KINDS = ["ask", "ask_resolved", "turn_done", "turn_failed"] as const;
export const PushKindSchema = z.enum(PUSH_KINDS);
export type PushKind = z.infer<typeof PushKindSchema>;

/**
 * The sealed plaintext: what the app shows once it has opened the envelope.
 *
 * `v` is the plaintext's OWN version (`1`): the extension refuses a future one
 * by showing the placeholder, never by guessing (F16). `id` is a 128-bit random
 * the extension dedupes on (F7: a replayed push shows nothing new), `at` its
 * timestamp (older than 24 h is discarded).
 */
export const PushMessageSchema = z.object({
  v: z.literal(1),
  id: z.string().regex(HEX_128_RE),
  at: z.number().int().nonnegative(),
  kind: PushKindSchema,
  computer: line(PUSH_COMPUTER_MAX),
  /** The project key, exactly as `daemon/discover` reports it. */
  cwd: line(PUSH_CWD_MAX),
  sessionId: line(PUSH_SESSION_ID_MAX),
  title: line(PUSH_TITLE_MAX),
  ask: PushAskSchema.optional(),
  turn: PushTurnSchema.optional(),
});
export type PushMessage = z.infer<typeof PushMessageSchema>;

/**
 * The envelope — the one custom key of an APNs payload: the recipient's key id
 * `k` (so the extension picks the right pinned computer among several), the
 * ephemeral `e` and the ciphertext `c`, both base64url.
 *
 * `k` is also the AEAD's `aad` (P1), so a ciphertext cannot be moved to another
 * paired computer. It links a push to a computer, which the relay already knows
 * from the relay id.
 */
export const PushEnvelopeSchema = z.object({
  v: z.literal(1),
  k: z.string().regex(new RegExp(`^[A-Za-z0-9_-]{${PUSH_KID_LENGTH}}$`)),
  e: z.string().regex(PUSH_KEY_RE),
  c: z.string().regex(PUSH_CIPHERTEXT_RE),
});
export type PushEnvelope = z.infer<typeof PushEnvelopeSchema>;

/**
 * The APNs payload's custom key, as the daemon hands it to the relay: `{"tp":
 * <envelope>}` and nothing else.
 *
 * `aps` is deliberately NOT a field: the relay builds it from its own fixed
 * template (P4), so a daemon can never put plaintext — or a chosen title — in a
 * banner the OS shows without opening the seal. A peer that sends one has it
 * stripped by this strip schema, which is the point.
 */
export const PushPayloadSchema = z.object({ tp: PushEnvelopeSchema });
export type PushPayload = z.infer<typeof PushPayloadSchema>;

/**
 * How one push ended, as the relay reports it (P3's `push-result`): `sent`,
 * `gone` (APNs 410 / a bad token — the daemon deletes that registration),
 * `rejected` (another 4xx), `throttled` (429) and `unavailable` (5xx, timeout,
 * link down). A shared constant so the relay frame and the daemon's sink cannot
 * disagree about the vocabulary.
 */
export const PUSH_DELIVERY_STATUSES = [
  "sent",
  "gone",
  "rejected",
  "throttled",
  "unavailable",
] as const;
export const PushDeliveryStatusSchema = z.enum(PUSH_DELIVERY_STATUSES);
export type PushDeliveryStatus = z.infer<typeof PushDeliveryStatusSchema>;

/** `true` iff `value` is a delivery status this build knows (an unknown one is not). */
export function isPushDeliveryStatus(value: unknown): value is PushDeliveryStatus {
  return typeof value === "string" && (PUSH_DELIVERY_STATUSES as readonly string[]).includes(value);
}

/**
 * The `apns-collapse-id` for one push. Two pushes with the same id replace each
 * other on the phone, which is the behaviour the whole design leans on:
 * `ask_resolved` replaces the `ask`'s banner, and folded asks share one
 * ("+N more waiting").
 *
 * `key` comes FIRST because truncation keeps the head: real ids are UUIDs, and
 * it must stay possible to tell two asks of one session apart. Encoded as
 * base64url so the result is always a valid header value (`>`/`"`/a control
 * character in a session id would otherwise corrupt the request).
 */
export function pushCollapseIdOf(sessionId: string, key: string): string {
  const bytes = encoder.encode(`${key}\u0000${sessionId}`);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  const encoded = btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return encoded.slice(0, PUSH_COLLAPSE_ID_MAX);
}

/**
 * How hard `fitPushMessage` may shrink each field, in the order it gives way:
 * what carries the least goes first (the command preview), and what makes the
 * push actionable or identifiable goes last (the ask's `requestId`).
 */
const LADDER: readonly ((message: PushMessage) => PushMessage)[] = [
  // 1. The preview is the first thing to go.
  (m) => (m.ask?.preview === undefined ? m : { ...m, ask: { ...m.ask, preview: undefined } }),
  // 2. Then the long free text: the ask's title and the push's title.
  (m) => ({
    ...m,
    title: clipKeep(m.title, 120),
    ask: m.ask === undefined ? undefined : { ...m.ask, title: clipKeep(m.ask.title, 160) },
  }),
  // 3. The option names, and all but the first few options.
  (m) => ({
    ...m,
    ask:
      m.ask === undefined
        ? undefined
        : {
            ...m.ask,
            options: m.ask.options.slice(0, 4).map((o) => ({ ...o, name: clipKeep(o.name, 40) })),
          },
  }),
  // 4. The project path (a phone only needs enough of it to name the project).
  (m) => ({ ...m, cwd: clipKeep(m.cwd, 256) }),
  // 5. The tool name.
  (m) => ({
    ...m,
    ask: m.ask === undefined ? undefined : { ...m.ask, tool: clipKeep(m.ask.tool, 40) },
  }),
  // 6. Titles down to a readable stub, one option.
  (m) => ({
    ...m,
    title: clipKeep(m.title, 60),
    ask:
      m.ask === undefined
        ? undefined
        : {
            ...m.ask,
            title: clipKeep(m.ask.title, 60),
            options: m.ask.options.slice(0, 1).map((o) => ({ ...o, name: clipKeep(o.name, 24) })),
          },
  }),
  // 7. Identity fields.
  (m) => ({
    ...m,
    cwd: clipKeep(m.cwd, 64),
    computer: clipKeep(m.computer, 32),
    sessionId: clipKeep(m.sessionId, 64),
  }),
  // 8. The ids themselves, and a turn's error line.
  (m) => ({
    ...m,
    sessionId: clipKeep(m.sessionId, 32),
    ask: m.ask === undefined ? undefined : { ...m.ask, requestId: clipKeep(m.ask.requestId, 64) },
    turn:
      m.turn === undefined
        ? undefined
        : {
            ...m.turn,
            turnId: clipKeep(m.turn.turnId, 32),
            error: m.turn.error === undefined ? undefined : clipKeep(m.turn.error, 60),
          },
  }),
  // 9. Last resort: every text at a stub. Still a valid, openable message.
  (m) => ({
    ...m,
    computer: clipKeep(m.computer, 16),
    cwd: clipKeep(m.cwd, 16),
    sessionId: clipKeep(m.sessionId, 16),
    title: clipKeep(m.title, 24),
    ask:
      m.ask === undefined
        ? undefined
        : {
            requestId: clipKeep(m.ask.requestId, 24),
            tool: clipKeep(m.ask.tool, 16),
            title: clipKeep(m.ask.title, 24),
            options: m.ask.options.slice(0, 1).map((o) => ({
              ...o,
              optionId: clipKeep(o.optionId, 16),
              name: clipKeep(o.name, 16),
            })),
          },
    turn: m.turn === undefined ? undefined : { turnId: clipKeep(m.turn.turnId, 16) },
  }),
];

const encodeMessage = (message: PushMessage): Uint8Array => encoder.encode(JSON.stringify(message));

/**
 * The plaintext to seal for `message`: the message itself when it fits, else
 * progressively clipped (see {@link LADDER}) until it does.
 *
 * This is the ONLY producer-side guarantee that a push fits an APNs payload: the
 * schema caps alone do not bound the total (every field at its cap is ~14 KiB of
 * UTF-8), and the relay cannot clip a sealed ciphertext. The worst case it
 * accepts is sealed into the 2048-byte bucket, so the envelope plus the relay's
 * fixed `aps` stays under APNs's 4096 bytes — pinned by a test that seals it.
 */
export function fitPushMessage(message: PushMessage): Uint8Array {
  let candidate = message;
  let bytes = encodeMessage(candidate);
  if (bytes.length <= PUSH_PLAINTEXT_MAX_BYTES) {
    return bytes;
  }
  for (const step of LADDER) {
    candidate = step(candidate);
    bytes = encodeMessage(candidate);
    if (bytes.length <= PUSH_PLAINTEXT_MAX_BYTES) {
      return bytes;
    }
  }
  // Unreachable: the last rung is a few hundred bytes. A bug here must be loud,
  // and P7's hook wraps `fitPushMessage`'s caller so a throw never reaches a turn.
  throw new Error(
    `fitPushMessage: even the smallest form exceeds ${PUSH_PLAINTEXT_MAX_BYTES} bytes`,
  );
}

// --- device/push_register + device/push_unregister -------------------------
// Reachable on a DEVICE connection only (the per-principal gate in
// `connection.ts`; a `token` or `pairing` connection gets the usual refusal).
// Push carries the phone's APNs token and its public push key — never a secret
// of the computer's — so the daemon stores the registration and nothing else.

/** The APNs environments: which Apple host the relay must use for this token. */
export const PUSH_ENVIRONMENTS = ["sandbox", "production"] as const;
export const PushEnvironmentSchema = z.enum(PUSH_ENVIRONMENTS);
export type PushEnvironment = z.infer<typeof PushEnvironmentSchema>;

/**
 * `device/push_register` params. The token is the RAW APNs token as lowercase
 * hex (P0(d): `getDevicePushTokenAsync` hex-encodes it, and no Expo service is
 * involved); `key` is the device's per-device X25519 push key, base64url — NOT
 * its Noise key, so the extension that opens pushes never holds the key that
 * authenticates the device.
 *
 * Both are bounded and alphabet-checked, so a malformed one is `InvalidParams`
 * and nothing is written (F26, F25).
 */
export const DevicePushRegisterParamsSchema = z.object({
  token: z.string().regex(PUSH_TOKEN_RE),
  env: PushEnvironmentSchema,
  key: z.string().regex(PUSH_KEY_RE),
});
export type DevicePushRegisterParams = z.infer<typeof DevicePushRegisterParamsSchema>;

/**
 * Why notifications will or will not arrive, so Settings can say it honestly:
 * `on`, `off` (`push.enabled` is false), `relay-off` (this computer talks to no
 * relay at all) and `relay-no-push` (its relay has no APNs key — F4).
 */
export const PUSH_REGISTER_STATUSES = ["on", "off", "relay-off", "relay-no-push"] as const;
export const PushRegisterStatusSchema = z.enum(PUSH_REGISTER_STATUSES);
export type PushRegisterStatus = z.infer<typeof PushRegisterStatusSchema>;

/** `device/push_register`'s result: the status, and the grace an ask waits. */
export const DevicePushRegisterResultSchema = z.object({
  graceSeconds: z.number().int().min(0).max(PUSH_GRACE_MAX_SECONDS),
  push: PushRegisterStatusSchema,
});
export type DevicePushRegisterResult = z.infer<typeof DevicePushRegisterResultSchema>;

/** `device/push_unregister` takes nothing: the device is the connection's own. */
export const DevicePushUnregisterParamsSchema = z.object({});
export type DevicePushUnregisterParams = z.infer<typeof DevicePushUnregisterParamsSchema>;

/** `device/push_unregister`'s result: nothing to say. */
export const DevicePushUnregisterResultSchema = z.object({});
export type DevicePushUnregisterResult = z.infer<typeof DevicePushUnregisterResultSchema>;
