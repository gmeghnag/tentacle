/**
 * The app's OWN log says a link really dialled (docs/feat/mobile-lock.md D7/F16).
 *
 * A flow that ends on `assertVisible: computers-list` proves only that the list is
 * still drawn (e2e-flows' rule, review finding 2). This is the daemon-side truth
 * available to a lock flow: after the unlock the app attaches, and the ATTACH is
 * not something the screen can prove — but the app's own log can, because the dial
 * is written before any pixel changes.
 *
 * Throws when the log has no `dial` line, so the last step cannot be vacuous.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/log-file`);
if (!response.ok) {
  throw new Error(`log-file failed: ${response.status} ${response.body}`);
}
const text = json(response.body).text;
if (typeof text !== "string" || !text.includes("dial")) {
  throw new Error(`the app's log has no dial after the unlock: ${JSON.stringify(text)}`);
}
output.logHasDial = true;
