/**
 * Flow 16's daemon-truth assertion: the text went out EXACTLY ONCE. The app was
 * killed with the item on disk, so a second attempt under the same key is the whole
 * point — two user messages would be a duplicate send (F3/F4, the load-bearing
 * assumption of the plan).
 */
const history = http.get(`http://${MAESTRO_HOOKS}/history?session=${OUTBOX_ID}`);
if (!history.ok) {
  throw new Error(`history failed: ${history.status} ${history.body}`);
}
const messages = json(history.body).history.messages;
const mine = messages.filter((m) => m.role === "user" && m.text.includes("OUTBOX sixteen"));
if (mine.length !== 1) {
  throw new Error(`the offline message went out ${mine.length} times: ${JSON.stringify(mine)}`);
}
output.sent = String(mine.length);
