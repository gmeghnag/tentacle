/**
 * Flow 37: `tentacle devices revoke <A's device id>` — the phone's pairing of
 * project A only. B was paired with its OWN fresh device key, so B must stay.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/pair-revoke?name=${output.deviceA}`);
if (!response.ok || json(response.body).code !== 0) {
  throw new Error(`pair-revoke(${output.deviceA}) failed: ${response.status} ${response.body}`);
}
output.revoked = output.deviceA;
