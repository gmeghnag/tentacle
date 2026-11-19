/**
 * Flow 17: the laptop runs a turn on the SAME session while the phone's item waits
 * offline — on a side `serve` the phone cannot reach (the harness's
 * `laptop-offline-turn`), so the history has moved before the phone's `up` and its
 * `decide` must say "changed" (docs/fix/mobile-e2e-reds.md).
 */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-offline-turn?session=${CHANGED_ID}&prompt=laptop%20moved%20first`,
);
if (!response.ok) {
  throw new Error(`laptop-offline-turn failed: ${response.status} ${response.body}`);
}
output.laptopTurn = "done";
