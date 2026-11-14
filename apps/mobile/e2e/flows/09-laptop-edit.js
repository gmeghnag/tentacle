/**
 * Flow 09: the LAPTOP starts an `EDIT` turn with NO laptop answer, so the ask
 * hangs on the daemon and the PHONE's sheet is where it shows up. Then the laptop
 * answers it (`09-laptop-answer.js`), and the first answer wins.
 */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${ASK4_ID}&prompt=EDIT%20b.txt`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
output.laptopEdit = json(response.body).turnId;
