/**
 * Flow 27's last step (docs/feat/mobile-chrome.md S9): daemon truth, not what
 * the phone drew (plan P9). The person's message reached the CHILD's model (a
 * child round whose user text carries it — not the parent's `[user → sa-N]`
 * note, which ends "no reply is expected"), and the short child's report
 * reached the parent (the note that woke it).
 */
const prompts = http.get(`http://${MAESTRO_HOOKS}/model-prompts`);
if (!prompts.ok) {
  throw new Error(`model-prompts failed: ${prompts.status} ${prompts.body}`);
}
const seen = json(prompts.body).prompts;
const toChild = seen.some(
  (prompt) => prompt.includes("salta i test") && !prompt.includes("no reply is expected"),
);
if (!toChild) {
  throw new Error(`the message never reached the child's model: ${JSON.stringify(seen)}`);
}
if (!seen.some((prompt) => prompt.includes("Child report: 3 steps done."))) {
  throw new Error(`the short child's report never reached the parent: ${JSON.stringify(seen)}`);
}
