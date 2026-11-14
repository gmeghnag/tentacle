/**
 * Flow 08c's daemon-side assertion (docs/feat/mobile-session-view.md 12c): the
 * person's words reached the MODEL — the mock records every refusal-with-a-reply
 * it was sent. A build that dropped the reply (or sent a bare No) fails here.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/model-replies`);
if (!response.ok) {
  throw new Error(`model-replies failed: ${response.status} ${response.body}`);
}
const replies = json(response.body).replies;
if (!replies.includes("put it in tmp instead")) {
  throw new Error(`the model never saw the reply: ${JSON.stringify(replies)}`);
}
output.replySeen = "true";
