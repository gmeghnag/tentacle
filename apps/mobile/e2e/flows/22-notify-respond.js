/**
 * The four response-injecting flows' action (docs/feat/mobile-notifications.md N8,
 * Owner Q7): hand the app the action a flow wants "tapped" on the LAST notification
 * `seal-push` placed.
 *
 * Maestro cannot long-press a system banner and pick an action, so this half is
 * injected. Everything AFTER it is the real path: the app re-opens the seal
 * (`notification-action.ts`), asks Face ID for an Approve (`notification-answer.ts`),
 * holds the gate, dials the computer's ONE link and sends the keyed
 * `session/resolve_permission` (N1) — and the flow's last step asserts DAEMON truth.
 *
 * `MAESTRO_NOTIFY_ACTION` and `MAESTRO_NOTIFY_TEXT` come from the flow's `env`.
 */
const action = MAESTRO_NOTIFY_ACTION;
if (typeof action !== "string" || action.length === 0) {
  throw new Error("MAESTRO_NOTIFY_ACTION is not set by the flow");
}
const text = MAESTRO_NOTIFY_TEXT;
const query =
  typeof text === "string" && text.length > 0
    ? `?action=${action}&text=${encodeURIComponent(text)}`
    : `?action=${action}`;
const response = http.get(`http://${MAESTRO_HOOKS}/notify-respond${query}`);
if (!response.ok) {
  throw new Error(`notify-respond failed: ${response.status} ${response.body}`);
}
const answer = json(response.body);
if (answer.accepted !== true) {
  throw new Error(`notify-respond was not accepted: ${JSON.stringify(answer)}`);
}
output.notifyRespond = String(action);
