/**
 * Flow 13's daemon-truth assertions: the OLD turn was cancelled and the new turn's
 * prompt holds BOTH texts (a send-now starts one turn with the queue's messages).
 * The screen's `composer-send-now` disappearing only says what was drawn.
 */
const prompts = http.get(`http://${MAESTRO_HOOKS}/model-prompts`);
if (!prompts.ok) {
  throw new Error(`model-prompts failed: ${prompts.status} ${prompts.body}`);
}
const seen = json(prompts.body).prompts;
const joined = seen.find(
  (prompt) => prompt.includes("SENDNOW one") && prompt.includes("SENDNOW two"),
);
if (joined === undefined) {
  throw new Error(`no model round holds both texts: ${JSON.stringify(seen)}`);
}
const queued = http.get(`http://${MAESTRO_HOOKS}/queue-state?session=${SENDNOW_ID}`);
const state = json(queued.body).state;
if (state.entries.length > 0) {
  throw new Error(`the send-now left rows queued: ${JSON.stringify(state.entries)}`);
}
output.prompt = joined;
