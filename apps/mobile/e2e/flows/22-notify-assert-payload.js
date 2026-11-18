/**
 * `22-notify-render`'s last step (docs/feat/mobile-notifications.md N8): the
 * payload the OS accepted carries a REAL sealed envelope, so what the banner was
 * drawn from is one the app's decrypt path can open.
 *
 * The decision (the envelope opens with the device key and the computer's pinned
 * key) is `e2e-notify-steps.test.ts`'s, under `bun test`. This script asserts the
 * shape only — Maestro's sandbox has no imports, so a decision here could never
 * be in the gate.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/notify-payload`);
if (!response.ok) {
  throw new Error(`notify-payload failed: ${response.status} ${response.body}`);
}
const payload = json(response.body).payload;
const tp = payload === undefined ? undefined : payload.tp;
if (tp === undefined || typeof tp !== "object") {
  throw new Error(`no sealed envelope was placed: ${JSON.stringify(payload)}`);
}
if (tp.v !== 1 || typeof tp.k !== "string" || tp.k.length !== 12) {
  throw new Error(`the envelope's version/key id are wrong: ${JSON.stringify(tp)}`);
}
if (typeof tp.e !== "string" || tp.e.length !== 43) {
  throw new Error(`the envelope's enc is not 32 bytes of base64url: ${JSON.stringify(tp.e)}`);
}
if (typeof tp.c !== "string" || tp.c.length === 0) {
  throw new Error("the envelope carries no ciphertext");
}
// The outer `aps` the relay built must still ask for the NSE to run.
if (payload.aps === undefined || payload.aps["mutable-content"] !== 1) {
  throw new Error(`the aps does not request the extension: ${JSON.stringify(payload.aps)}`);
}
output.notifyPayload = "sealed";
