/**
 * Flow 37: remember project A's pairing before B's overwrites `output`.
 *
 * - `rowA`: A's row id (`<computer>.<projectHash>`, mobile-projects §6);
 * - `machine`: the computer's id — the section's testIDs are keyed by it;
 * - `deviceA`: the device id `pair` registered for A. `/pair-device-id` answers
 *   the LAST completed pairing, so it must be read now, before B pairs; the
 *   revoke later names exactly A's device (never B's, never a previous run's).
 */
output.rowA = output.computerId;
output.machine = output.computerId.split(".")[0];
const id = http.get(`http://${MAESTRO_HOOKS}/pair-device-id`);
if (!id.ok) {
  throw new Error(`pair-device-id failed: ${id.status} ${id.body}`);
}
output.deviceA = json(id.body).deviceId;
