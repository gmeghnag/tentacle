/**
 * `22-notify-reply`'s model assertion (docs/feat/mobile-notifications.md N8): the
 * person's words, typed into a notification's Reply, reached the MODEL.
 *
 * Why this and not a screen: the daemon appends a denial's reply to the model's
 * next round (`denialReply`, docs/feat/permission-reply.md), so the mock model's
 * prompt list is the only place the words can be observed — and a screen would
 * prove only that the app drew something.
 *
 * Maestro's JS is Rhino: a TIME budget, no `sleep` (see `12-steer.js`).
 */
const deadline = Date.now() + 20000;
const arrived = () => {
  const response = http.get(`http://${MAESTRO_HOOKS}/model-prompts`);
  if (!response.ok) {
    throw new Error(`model-prompts failed: ${response.status} ${response.body}`);
  }
  const prompts = json(response.body).prompts;
  return (
    Array.isArray(prompts) && prompts.some((prompt) => String(prompt).includes("use bun instead"))
  );
};
while (Date.now() < deadline && !arrived()) {
  // each call is a real HTTP round trip: time passes
}
if (!arrived()) {
  throw new Error("the reply never reached a model round");
}
output.notifyReply = "reached-model";
