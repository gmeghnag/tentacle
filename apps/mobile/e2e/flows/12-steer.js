/**
 * Flow 12's daemon-truth assertions (docs/feat/mobile-compose.md 13d): the steer the
 * phone queued was (1) a real row of the daemon's queue, bound to the turn that ran,
 * and (2) injected INTO that turn — so it reached the mock model, and the queue no
 * longer lists it.
 *
 * A steer is injected at the turn's NEXT model-round boundary, not on the ack, so
 * this WAITS for it (up to ~20 s) instead of sampling once: the first run asserted
 * too early and saw the row still queued.
 *
 * The screen's `queued-row-*` / `composer-queue` only say what was DRAWN (plan P9);
 * this is what the daemon did.
 */
function get(path) {
  const response = http.get(`http://${MAESTRO_HOOKS}/${path}`);
  if (!response.ok) {
    throw new Error(`${path} failed: ${response.status} ${response.body}`);
  }
  return json(response.body);
}

// Maestro's JavaScript is Rhino: no `Thread.sleep`, no Promises. A steer is injected
// at the turn's NEXT model-round boundary, so this polls with a real TIME budget
// (`Date.now`) instead of a bare loop — the first attempt burned 200 round trips in
// about a second and asserted far too early.
const session = `session=${STEER_ID}`;
const deadline = Date.now() + 25000;
let queued = get(`queue-state?${session}`).state;
while (Date.now() < deadline && queued.entries.some((row) => row.text === "STEER twelve")) {
  queued = get(`queue-state?${session}`).state;
}
if (queued.entries.some((row) => row.text === "STEER twelve")) {
  throw new Error(`the steer never left the queue: ${JSON.stringify(queued.entries)}`);
}
const prompts = get("model-prompts").prompts;
if (!prompts.some((prompt) => prompt.includes("STEER twelve"))) {
  throw new Error(`the steer reached no model round: ${JSON.stringify(prompts)}`);
}
output.queued = JSON.stringify(queued);
output.steerInjected = "true";
