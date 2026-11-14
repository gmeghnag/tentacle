/**
 * Flow 17's daemon-truth assertion: the sheet's Send went out ONCE, with the item's
 * ORIGINAL key — so even if the first attempt had landed, there is no duplicate.
 */
const history = http.get(`http://${MAESTRO_HOOKS}/history?session=${CHANGED_ID}`);
if (!history.ok) {
  throw new Error(`history failed: ${history.status} ${history.body}`);
}
const messages = json(history.body).history.messages;
const mine = messages.filter((m) => m.role === "user" && m.text.includes("CHANGED seventeen"));
if (mine.length !== 1) {
  throw new Error(`the sheet's Send produced ${mine.length} messages: ${JSON.stringify(mine)}`);
}
output.sent = String(mine.length);
