/**
 * Flow 48: the LAPTOP starts an `EDIT` turn on the flow's session while the phone
 * shows one of its workflow runs, with no laptop answer — the ask is the main
 * turn's, so the run screen offers only «Open the session».
 */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${OPENSESSION_ID}&prompt=EDIT%20w48.txt`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
