/**
 * Flow 10: the LAPTOP starts an `EDIT` turn on the open session, with no laptop
 * answer — so the ask it raises can only be answered from the phone, and only
 * when the phone is back (docs/feat/mobile-session-view.md 12c).
 */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${ASK5_ID}&prompt=EDIT%20c.txt`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
output.backgroundEdit = json(response.body).turnId;
