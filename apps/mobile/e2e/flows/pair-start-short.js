/**
 * Flow 13's own opener (docs/feat/mobile-pairing-screen.md 11b.1, F-P4): the same
 * in-process `tentacle pair`, with a 1.5 s window — short enough that the flow can
 * wait it out and still be a quick flow, long enough that opening it is not the
 * race. A dedicated script rather than a global `-e PAIR_TTL_MS`: every other
 * flow needs the default 5 minutes, and a global short TTL would make their
 * pastes race the window.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/pair-start?ttlMs=1500`);
if (!response.ok) {
  throw new Error(`pair-start failed: ${response.status} ${response.body}`);
}
const started = json(response.body);
output.payload = started.payload;
output.computerId = started.computerId;
