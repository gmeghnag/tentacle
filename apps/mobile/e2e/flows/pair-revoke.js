/**
 * Flow 15's step (docs/feat/mobile-pairing-screen.md 11b.1, F-L1): revoke THIS
 * phone on the computer.
 *
 * NOT by name: a harness config dir accumulates one device per run (`iPhone`,
 * `iPhone (2)`, …), so `devices revoke iPhone` either refuses as ambiguous or
 * revokes a PREVIOUS run's device — leaving the phone under test valid, which is
 * exactly how the first iOS 26 attempt failed. `/pair-device-id` returns the id
 * `pair` reported for the pairing this flow just completed, and `devices revoke`
 * takes an id.
 */
const id = http.get(`http://${MAESTRO_HOOKS}/pair-device-id`);
if (!id.ok) {
  throw new Error(`pair-device-id failed: ${id.status} ${id.body}`);
}
const deviceId = json(id.body).deviceId;
const response = http.get(`http://${MAESTRO_HOOKS}/pair-revoke?name=${deviceId}`);
if (!response.ok || json(response.body).code !== 0) {
  throw new Error(`pair-revoke(${deviceId}) failed: ${response.status} ${response.body}`);
}
output.revoked = deviceId;
