/**
 * Flow 07's daemon-truth assertion (docs/feat/mobile-session-view.md 12c): the
 * daemon's history (by `snapshot`) holds the text the flow typed as the last
 * user message and the mock's answer after it. The screen could show anything;
 * this is what is actually in the session.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/history?session=${ALPHA_ID}`);
if (!response.ok) {
  throw new Error(`history failed: ${response.status} ${response.body}`);
}
const history = json(response.body).history;
if (history.user !== "STEADY flow seven prompt") {
  throw new Error(`the daemon's last user message is ${JSON.stringify(history.user)}`);
}
if (typeof history.assistant !== "string" || !history.assistant.includes("mock model")) {
  throw new Error(`the daemon has no mock answer: ${JSON.stringify(history.assistant)}`);
}
const prompts = http.get(`http://${MAESTRO_HOOKS}/model-prompts`);
// Matched on what was typed: context awareness appends "\n\n[context: …]".
const asked = (p) => p === "STEADY flow seven prompt" || p.startsWith("STEADY flow seven prompt\n");
if (!json(prompts.body).prompts.some(asked)) {
  throw new Error("the mock model was never asked the prompt the flow typed");
}
output.history = JSON.stringify(history);
