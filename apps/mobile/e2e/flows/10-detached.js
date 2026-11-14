/**
 * Flow 10's mid-run assertion (docs/feat/mobile-session-view.md 12c): nobody
 * answered the ask while the phone was away, and the turn is still suspended on
 * it. That is the property the plan's F2/F3 rest on (P2: an ask with no attached
 * client WAITS), and it is what makes the resumed approval in `10-file.js` a real
 * assertion rather than a coincidence.
 *
 * NOT asserted: that `attached` drops to 1 the instant Home is pressed. The first
 * iOS 26 run showed it does not: iOS suspends the JS thread as the app goes to
 * the background, so the gate's `suspend()` (and its socket close) is not
 * guaranteed to reach the wire before the process is frozen — the daemon only
 * notices when its own 60 s ping fails (`daemon/src/ws-server.ts`). The app still
 * SHEDS the link (`foreground-gate.ts` closes it as soon as JS runs again on
 * return), and the ask still waits; the daemon's `attached` count is the thing
 * that lags. Recorded as a finding in the task doc's Execution.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/session-state?session=${ASK5_ID}`);
if (!response.ok) {
  throw new Error(`session-state failed: ${response.status} ${response.body}`);
}
const state = json(response.body).state;
if (state === null) {
  throw new Error("the session vanished while the app was backgrounded");
}
if (state.running !== true) {
  throw new Error(
    `the turn ended instead of waiting for an answer (nobody was there to give one): ${JSON.stringify(state)}`,
  );
}
output.background = JSON.stringify(state);
