/**
 * Flow 12: a turn the LAPTOP starts on the flow's own session, with `GATED` so it
 * stays running until the flow RELEASES it (`12-release.js`) after the steer is
 * queued — no race against a timer (docs/fix/mobile-e2e-reds.md: the 20 s
 * `STEADY` turn ended before Maestro's ~27 s of tap + type + send on iOS 26). It
 * then ends, and the steer is injected at that model-round boundary.
 *
 * `STEER_ID` is a session of the flow's own (seeded like the permission ones): an
 * ask or a queue left pending is daemon-side state that survives `clearState`.
 */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${STEER_ID}&prompt=GATED%20turn%20for%20the%20steer`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
output.laptopTurn = json(response.body).turnId;
