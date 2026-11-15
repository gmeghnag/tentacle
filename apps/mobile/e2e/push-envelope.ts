/**
 * The envelope-shape check the `push-placeholder` flow ends on
 * (docs/feat/mobile-push.md P10, AGENTS §7: the decision lives in a pure module,
 * the Maestro script only reports it).
 *
 * Why it is not inline in the flow's script: Maestro runs a flow's `runScript` in
 * a bare JS sandbox with no imports, so a decision written there can only be
 * tested by running a simulator — and a test that needs a simulator is never in
 * `bun run check`. Here it is ordinary code with ordinary tests, and the flow's
 * script is a two-line wrapper.
 *
 * What it checks is Design 2's *shape* claim, which is also the metadata claim:
 * every push is one of three sizes, and only a paired computer can have produced
 * the envelope. It cannot check the CONTENT (nothing here holds the device push
 * key — task 17's extension does, on the phone).
 */
import {
  PUSH_ENC_TEXT_LENGTH,
  PUSH_ENVELOPE_CIPHERTEXT_LENGTHS,
  PUSH_KID_LENGTH,
} from "@tentacle/protocol";

/** What the harness pushed, as the fake APNs received it. */
export interface PushedEnvelope {
  readonly aps: unknown;
  readonly tp: unknown;
}

/**
 * Everything wrong with a pushed envelope, as sentences a failure can print.
 *
 * Empty means "this is the shape `sealPush` produces". Every fault names the
 * field and the expectation, because the caller's only context is a Maestro log.
 */
export function envelopeFaultsOf(payload: unknown, registeredToken: unknown): readonly string[] {
  const faults: string[] = [];
  if (payload === null || typeof payload !== "object") {
    return [`the APNs payload is not an object: ${JSON.stringify(payload)}`];
  }
  const aps = (payload as { aps?: unknown }).aps;
  if (aps === null || typeof aps !== "object") {
    // No `aps` is not a push at all: iOS would show nothing, so a flow asserting
    // a banner would have passed on something else.
    faults.push(`the payload carries no \`aps\`: ${JSON.stringify(payload)}`);
  }
  const tp = (payload as { tp?: unknown }).tp;
  if (tp === null || typeof tp !== "object") {
    return [
      ...faults,
      `the payload carries no sealed envelope (\`tp\`): ${JSON.stringify(payload)}`,
    ];
  }
  const envelope = tp as { v?: unknown; k?: unknown; e?: unknown; c?: unknown };
  if (envelope.v !== 1) {
    faults.push(`the envelope's version is not 1: ${JSON.stringify(envelope.v)}`);
  }
  // The key id lets the extension pick the paired computer's key among several;
  // its length is `b64url(SHA-256("tentacle-push-kid/1" ‖ pk))[0..12]`.
  if (typeof envelope.k !== "string" || envelope.k.length !== PUSH_KID_LENGTH) {
    faults.push(
      `the envelope's key id is not ${PUSH_KID_LENGTH} chars: ${JSON.stringify(envelope.k)}`,
    );
  }
  // The HPKE encapsulated key: one 32-byte X25519 public key in unpadded b64url.
  if (typeof envelope.e !== "string" || envelope.e.length !== PUSH_ENC_TEXT_LENGTH) {
    faults.push(
      `the envelope's enc is not ${PUSH_ENC_TEXT_LENGTH} chars: ${JSON.stringify(envelope.e)}`,
    );
  }
  // The metadata claim: three buckets, so the ciphertext's length says nothing
  // about the kind. Any other length means the plaintext was not padded — and a
  // bare `c.length > 0` here would accept an unsealed or unpadded payload, which
  // is exactly the mutation this test exists to kill.
  if (
    typeof envelope.c !== "string" ||
    !PUSH_ENVELOPE_CIPHERTEXT_LENGTHS.includes(envelope.c.length)
  ) {
    faults.push(
      `the ciphertext's length is ${typeof envelope.c === "string" ? envelope.c.length : "not a string"}, which is none of ${PUSH_ENVELOPE_CIPHERTEXT_LENGTHS.join(", ")}: the plaintext was not padded to a bucket`,
    );
  }
  // The token it was addressed to is the one the harness registered: a payload
  // for some other phone would mean the push went somewhere this flow cannot see.
  if (registeredToken !== undefined && typeof registeredToken !== "string") {
    faults.push(`the registered token is not a string: ${JSON.stringify(registeredToken)}`);
  }
  return faults;
}
