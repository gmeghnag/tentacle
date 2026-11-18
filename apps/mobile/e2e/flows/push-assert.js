/**
 * `push-placeholder`'s last step (docs/feat/mobile-push.md P10, AGENTS §9): the
 * payload that reached the OS is the daemon's OWN sealed envelope — not a
 * hand-written file, and not something the app could have invented.
 *
 * The DECISION is `envelopeFaultsOf` (`apps/mobile/e2e/push-envelope.ts`), which
 * `bun test` covers. This script only reports it: Maestro runs `runScript` in a
 * sandbox with no imports, so a decision written HERE would need a simulator to
 * test and could never be in the gate — and the first version of this file proved
 * exactly why that matters (it asserted the presence of the digits "704" instead
 * of the behaviour, so a mutation that accepted any ciphertext length survived).
 */
const response = http.get(`http://${MAESTRO_HOOKS}/push-payload`);
if (!response.ok) {
  throw new Error(`push-payload failed: ${response.status} ${response.body}`);
}
const answer = json(response.body);
// The three shape faults `envelopeFaultsOf` reports, repeated as the SAME rules:
// the harness's own `envelopeFaultsOf` is what the unit tests drive, and this is
// its transport-side twin (a script cannot import). Kept in lockstep by
// `apps/mobile/test/push-envelope.test.ts`'s "the script's rules match the module"
// case, which reads BOTH files.
const tp = answer.payload === undefined ? undefined : answer.payload.tp;
if (tp === undefined || typeof tp !== "object") {
  throw new Error(`no sealed envelope in what was pushed: ${JSON.stringify(answer.payload)}`);
}
if (tp.v !== 1) {
  throw new Error(`the envelope's version is not 1: ${JSON.stringify(tp.v)}`);
}
if (typeof tp.k !== "string" || tp.k.length !== 12) {
  throw new Error(`the envelope's key id is not 12 chars: ${JSON.stringify(tp.k)}`);
}
if (typeof tp.e !== "string" || tp.e.length !== 43) {
  throw new Error(`the envelope's enc is not 43 chars: ${JSON.stringify(tp.e)}`);
}
// The three padded buckets' ciphertext lengths (PUSH_ENVELOPE_CIPHERTEXT_LENGTHS).
const ciphertext = typeof tp.c === "string" ? tp.c : "";
const buckets = [704, 1387, 2752];
if (!buckets.includes(ciphertext.length)) {
  throw new Error(
    `the ciphertext is ${ciphertext.length} chars, which is none of the three padding buckets (${buckets.join(
      ", ",
    )}): the plaintext was not padded`,
  );
}
// The token the harness registered: a payload addressed to some other phone would
// mean the push went somewhere this flow cannot see.
if (answer.token !== "ab".repeat(32)) {
  throw new Error(`the pushed token is not the registered one: ${JSON.stringify(answer.token)}`);
}
output.pushed = "true";
