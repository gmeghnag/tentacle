/**
 * Flow 16's daemon-truth assertion: the text went out EXACTLY ONCE. The app was
 * killed with the item on disk, so a second attempt under the same key is the whole
 * point — two user messages would be a duplicate send (F3/F4, the load-bearing
 * assumption of the plan).
 */
function sent() {
  const history = http.get(`http://${MAESTRO_HOOKS}/history?session=${OUTBOX_ID}`);
  if (!history.ok) {
    throw new Error(`history failed: ${history.status} ${history.body}`);
  }
  const messages = json(history.body).history.messages;
  return messages.filter((m) => m.role === "user" && m.text.includes("OUTBOX sixteen"));
}
// The outbox runs on the session's re-sync, which the flow just opened: wait for
// the send (Rhino has no sleep, so a TIME-bounded poll), then let a duplicate,
// if any, land too before counting (docs/fix/mobile-e2e-reds.md).
const deadline = Date.now() + 30000;
let mine = sent();
while (Date.now() < deadline && mine.length === 0) {
  mine = sent();
}
const settle = Date.now() + 3000;
while (Date.now() < settle) {
  mine = sent();
}
if (mine.length !== 1) {
  throw new Error(`the offline message went out ${mine.length} times: ${JSON.stringify(mine)}`);
}
output.sent = String(mine.length);
