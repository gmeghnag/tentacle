/**
 * The canary assertions for flow 21 (docs/feat/mobile-lock.md F16): the app's OWN
 * log file must not contain any secret from this run.
 *
 * In a script, not in `assertTrue:` steps, for two reasons: the repo's flows
 * assert by testID and put every truth-check in a `runScript` (e2e-flows' rule),
 * and a script THROWS with the offending canary named, so a failure says WHICH
 * secret leaked instead of "assertTrue was false".
 *
 * The canaries come from this run's world: the seeded session titles, the HOLD
 * prompt's marker, and the harness token (which would appear as `token=` in any
 * URL the app logged).
 */
const response = http.get(`http://${MAESTRO_HOOKS}/log-file`);
if (!response.ok) {
  throw new Error(`log-file failed: ${response.status} ${response.body}`);
}
const text = json(response.body).text;
if (typeof text !== "string") {
  throw new Error(`the app's log file is missing: ${JSON.stringify(text)}`);
}
// Non-vacuity first: an empty log would make every negative assertion true.
if (!text.includes("dial")) {
  throw new Error(`the app's log records no dial, so the canaries prove nothing: ${text}`);
}
const canaries = ["Alpha", "Bravo", "Charlie", "HOLD", "CANARY", "token="];
const leaked = canaries.filter((canary) => text.includes(canary));
if (leaked.length > 0) {
  throw new Error(`the app's log leaked ${leaked.join(", ")}: ${text}`);
}
output.logCanariesClean = true;
