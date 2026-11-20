/**
 * Flow 12 (docs/fix/mobile-e2e-reds.md): the steer is queued, so end the mock's
 * `GATED` turn — the daemon then injects the steer at that round boundary, which
 * `12-steer.js` asserts. Throws when no turn was waiting: the gate was never
 * reached, or it ended at its cap, so the steer was not queued INTO a running turn.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/model-release`);
if (!response.ok) {
  throw new Error(`model-release failed: ${response.status} ${response.body}`);
}
if (json(response.body).released !== true) {
  throw new Error("model-release: no GATED turn was waiting");
}
output.released = "true";
