/**
 * Flow 30's `present` (docs/feat/model-artifacts.md T8.1): the card the escape
 * suite taps. The mock model's `ESCAPE30` turn `present`s the run's own
 * `project/escape.html` — the hostile fixture with `__PROBE__` already replaced by
 * this run's listener — so the artifact under test is the real one, presented
 * through the real tool, reaching the phone through the real daemon.
 *
 * `laptop-prompt` starts that turn on the phone's own session but from the
 * HARNESS's client, and the phone (already attached) streams the card in — the
 * same path a turn started from any other device takes.
 */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${ESCAPE_ID}&prompt=ESCAPE30`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
output.escapeTurn = json(response.body).turnId;
