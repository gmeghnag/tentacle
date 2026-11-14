/**
 * Flow 18's daemon-truth assertion: the message names BOTH refs, with the types the
 * BYTES decided (a PNG and a JPEG — never the picker's own mime, 13c's rule), and the
 * mock model was asked with two image parts (`saw 2 images`).
 */
const history = http.get(`http://${MAESTRO_HOOKS}/history?session=${PHOTO_ID}`);
if (!history.ok) {
  throw new Error(`history failed: ${history.status} ${history.body}`);
}
const messages = json(history.body).history.messages;
const mine = messages.find((m) => m.role === "user" && m.text.includes("PHOTO eighteen"));
if (mine === undefined) {
  throw new Error(`the photo message is not in the daemon's history: ${JSON.stringify(messages)}`);
}
if (mine.images.length !== 2) {
  throw new Error(`the message names ${mine.images.length} refs: ${JSON.stringify(mine.images)}`);
}
const types = mine.images.map((ref) => ref.mimeType).sort();
if (JSON.stringify(types) !== JSON.stringify(["image/jpeg", "image/png"])) {
  throw new Error(`unexpected ref types: ${JSON.stringify(types)}`);
}
const replies = http.get(`http://${MAESTRO_HOOKS}/history?session=${PHOTO_ID}`);
const answer = json(replies.body).history.assistant;
if (typeof answer !== "string" || !answer.includes("saw 2 images")) {
  throw new Error(`the model saw no images: ${JSON.stringify(answer)}`);
}
output.images = JSON.stringify(mine.images);
