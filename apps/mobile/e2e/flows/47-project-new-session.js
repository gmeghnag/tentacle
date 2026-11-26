/**
 * Flow 47's last step (docs/feat/mobile-project-new-session.md): the session the
 * list's New session button opened was created on THIS computer — its first
 * prompt reached the model (a send to an id that does not exist would never run).
 */
const prompts = http.get(`http://${MAESTRO_HOOKS}/model-prompts`);
if (!prompts.ok) {
  throw new Error(`model-prompts failed: ${prompts.status} ${prompts.body}`);
}
const seen = json(prompts.body).prompts;
if (!seen.some((prompt) => prompt.includes("NEWPROJECT flow forty-seven"))) {
  throw new Error(`the new session's first prompt never ran: ${JSON.stringify(seen)}`);
}
