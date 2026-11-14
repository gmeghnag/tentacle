/**
 * Flow 06's step (docs/feat/mobile-pairing-screen.md 11b.1, F-P7): answer the
 * terminal's `[y/N]` with `n`. A REFUSAL is a real path, not a failure: the flow
 * asserts the phone's own `pair-error-declined` next.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/pair-answer?answer=n`);
if (!response.ok) {
  throw new Error(`pair-answer (n) failed: ${response.status} ${response.body}`);
}
output.answered = json(response.body).answered;
