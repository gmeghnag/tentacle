/**
 * Flow 37 (docs/feat/mobile-projects.md): start or stop project B's `serve` — a
 * second project on the SAME computer (its own folder, the harness's config dir).
 * `ACTION` is `start` or `stop`; a restart keeps B's port (the phone paired it).
 */
const action = typeof ACTION === "undefined" ? "start" : ACTION;
const response = http.get(`http://${MAESTRO_HOOKS}/project-b-${action}`);
if (!response.ok) {
  throw new Error(`project-b-${action} failed: ${response.status} ${response.body}`);
}
output.projectB = action;
