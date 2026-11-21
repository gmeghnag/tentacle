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
// Matched on a LINE of what was typed (mock-model.ts `promptLine`): context
// awareness APPENDS "\n\n[context: …]", and the model's date stamp PREFIXES
// "[Sat 2026-11-21 18:56 CET]\n" (docs/fix/prompt-current-date.md) once Alpha's
// last stamp — its seeding — is over 30 min old, which it is when this flow runs
// late in the full suite (docs/fix/mobile-e2e-1121.md).
const asked = (p) => p.split("\n").some((line) => line.trim() === "relay only");
const seen = json(prompts.body).prompts;
if (!seen.some(asked)) {
  throw new Error(
    `the mock model was never asked the relay-only prompt (asked: ${JSON.stringify(seen)})`,
  );
}
output.relayHistory = JSON.stringify(history);
