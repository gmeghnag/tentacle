/**
 * `_pair` step 3 (docs/feat/mobile-pairing-screen.md 11b.1): wait for the phone's
 * claim, then take the compare code the TERMINAL is showing. The flow asserts the
 * phone drew the same one — the two ends agreeing is the security property, so it
 * is an assertion here, not a comment.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/pair-confirm`);
if (!response.ok) {
  throw new Error(`pair-confirm failed: ${response.status} ${response.body}`);
}
const sas = json(response.body).sas;
if (typeof sas !== "string" || sas.length !== 6) {
  throw new Error(`the terminal's compare code is not six digits: ${JSON.stringify(sas)}`);
}
output.sas = sas;
