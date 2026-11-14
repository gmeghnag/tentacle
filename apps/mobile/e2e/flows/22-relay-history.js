/**
 * Flow 22's first daemon-truth step (docs/feat/mobile-relay.md R6): the prompt
 * the flow typed reached the daemon and the mock model answered it — a turn that
 * only ever had a path through the relay.
 *
 * A screen cannot prove this: `turn-idle` says the app stopped drawing a spinner,
 * and a turn that never left the phone would look the same. `history` is the
 * daemon's own transcript, and `model-prompts` is what the provider was asked.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/history?session=${ALPHA_ID}`);
if (!response.ok) {
  throw new Error(`history failed: ${response.status} ${response.body}`);
}
const history = json(response.body).history;
if (history.user !== "relay only") {
  throw new Error(`the daemon's last user message is ${JSON.stringify(history.user)}`);
}
if (typeof history.assistant !== "string" || !history.assistant.includes("mock model")) {
  throw new Error(`the daemon has no mock answer: ${JSON.stringify(history.assistant)}`);
}
const prompts = http.get(`http://${MAESTRO_HOOKS}/model-prompts`);
if (!json(prompts.body).prompts.includes("relay only")) {
  throw new Error("the mock model was never asked the relay-only prompt");
}
output.relayHistory = JSON.stringify(history);
