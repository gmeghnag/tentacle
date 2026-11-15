/**
 * The notification answer flows' last step (docs/feat/mobile-notifications.md N8,
 * AGENTS §9): DAEMON truth, never the screen.
 *
 * A notification's answer is a keyed `session/resolve_permission`, so the thing
 * to read back is the daemon's own state for the session: the ask is gone (its
 * `pending-ask` list is empty) exactly when the answer landed.
 *
 * `MAESTRO_NOTIFY_EXPECT` is `answered` (the ask must be gone) or `pending` (the
 * forged/refused case: it must STILL be there — a flow asserting "nothing
 * happened" by looking at a screen would pass on a stale frame).
 *
 * Maestro's JavaScript is Rhino (`12-steer.js`): no `sleep`, no Promises, so this
 * polls with a real TIME budget instead of a bare loop.
 */
const session = ASK1_ID;
const expected = MAESTRO_NOTIFY_EXPECT;
if (expected !== "answered" && expected !== "pending") {
  throw new Error(`MAESTRO_NOTIFY_EXPECT must be answered|pending, got ${expected}`);
}
const pending = () => {
  const response = http.get(
    `http://${MAESTRO_HOOKS}/pending-ask?session=${encodeURIComponent(session)}`,
  );
  if (!response.ok) {
    throw new Error(`pending-ask failed: ${response.status} ${response.body}`);
  }
  const requests = json(response.body).requests;
  return Array.isArray(requests) ? requests : [];
};
const matches = () => (expected === "answered" ? pending().length === 0 : pending().length > 0);
const deadline = Date.now() + 25000;
while (Date.now() < deadline && !matches()) {
  // real time passes between calls: each one is an HTTP round trip
}
if (!matches()) {
  throw new Error(
    `notify truth: expected ${expected} on ${session}, the daemon still reports ${JSON.stringify(
      pending(),
    )}`,
  );
}
output.notifyTruth = expected;
