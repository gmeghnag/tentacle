/**
 * Flow 12: a turn the LAPTOP starts on the flow's own session, with `STEADY` so it
 * runs ~10 s and ends — long enough to type and queue a steer into it, and short
 * enough that the steer's next model-round boundary falls inside the flow's wait.
 *
 * `STEER_ID` is a session of the flow's own (seeded like the permission ones): an
 * ask or a queue left pending is daemon-side state that survives `clearState`.
 */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${STEER_ID}&prompt=STEADY%20turn%20for%20the%20steer`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
output.laptopTurn = json(response.body).turnId;
