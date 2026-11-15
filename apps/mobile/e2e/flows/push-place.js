/**
 * `push-placeholder`'s one action (docs/feat/mobile-push.md P10): register a push
 * key for the phone `_pair` just admitted, make the daemon push once, and place
 * the envelope it produced on the simulator.
 *
 * All three steps are the harness's (see `createPushSteps` in `run.ts` for WHY a
 * simulator needs them): a simulator has no APNs token, so the app cannot
 * register itself, and `simctl push` is the only way to make iOS draw a banner.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/push-place`);
if (!response.ok) {
  throw new Error(`push-place failed: ${response.status} ${response.body}`);
}
const placed = json(response.body);
// The payload is the daemon's sealed envelope: `tp` with a key id (`k`), an
// encapsulated key (`e`) and a ciphertext (`c`). Checked HERE, not in the flow,
// so a failed place says which of the three was missing.
const tp = placed.payload === undefined ? undefined : placed.payload.tp;
if (tp === undefined || typeof tp !== "object") {
  throw new Error(`the push carried no sealed envelope: ${JSON.stringify(placed.payload)}`);
}
for (const field of ["k", "e", "c"]) {
  if (typeof tp[field] !== "string" || tp[field].length === 0) {
    throw new Error(`the envelope's ${field} is missing: ${JSON.stringify(tp)}`);
  }
}
output.pushCiphertextLength = String(tp.c.length);
output.pushKeyId = String(tp.k);
output.pushToken = String(placed.token);
