/**
 * `22-notify-render`'s action (docs/feat/mobile-notifications.md N8): seal an ASK
 * of the flow's choosing to the phone's push key and place it.
 *
 * The DECISION (is the payload really sealed by the computer's key, and does it
 * open with the device's?) is `e2e-notify-steps.test.ts`'s — `bun test` opens the
 * payload with the device key. This script only reports what the harness placed:
 * Maestro runs `runScript` in a sandbox with no imports, so a decision written
 * here could never be in the gate.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/seal-push?kind=ask&reply=1`);
if (!response.ok) {
  throw new Error(`seal-push failed: ${response.status} ${response.body}`);
}
const placed = json(response.body);
const tp = placed.payload === undefined ? undefined : placed.payload.tp;
if (tp === undefined || typeof tp.v !== "number" || typeof tp.k !== "string") {
  throw new Error(`seal-push carried no envelope: ${JSON.stringify(placed.payload)}`);
}
output.sealPush = "placed";
