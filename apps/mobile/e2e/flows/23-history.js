/**
 * Flow 23's daemon-truth assertion (docs/feat/mobile-ui-polish.md Slice 0): BOTH
 * prompts reached the model — the one sent by tapping Send with the keyboard up
 * (B1) and the one sent by Return (B2) — and the daemon's last user message is
 * the Return one, with the mock's answer after it.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/history?session=${KEYBOARD_ID}`);
if (!response.ok) {
  throw new Error(`history failed: ${response.status} ${response.body}`);
}
const history = json(response.body).history;
if (history.user !== "SLOW keyboard return") {
  throw new Error(`the daemon's last user message is ${JSON.stringify(history.user)}`);
}
if (typeof history.assistant !== "string" || !history.assistant.includes("mock model")) {
  throw new Error(`the daemon has no mock answer: ${JSON.stringify(history.assistant)}`);
}
const prompts = json(http.get(`http://${MAESTRO_HOOKS}/model-prompts`).body).prompts;
for (const sent of ["SLOW keyboard button", "SLOW keyboard return"]) {
  if (!prompts.includes(sent)) {
    throw new Error(`the mock model was never asked ${JSON.stringify(sent)}`);
  }
}
output.history = JSON.stringify(history);
