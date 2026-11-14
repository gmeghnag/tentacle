/**
 * Flow 08: the tool-call id the mock model minted for this run's last `EDIT`
 * (docs/feat/mobile-session-view.md 12c). The row's testID is `tool-<id>-<status>`
 * and `diff-<id>`, so the flow must read the id the daemon really used.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/edit-calls`);
if (!response.ok) {
  throw new Error(`edit-calls failed: ${response.status} ${response.body}`);
}
const calls = json(response.body).calls;
if (calls.length === 0) {
  throw new Error("the mock model never minted a tool call: the EDIT prompt did not reach it");
}
output.callId = calls[calls.length - 1];
