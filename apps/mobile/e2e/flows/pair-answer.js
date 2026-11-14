/**
 * `_pair` step 4 (docs/feat/mobile-pairing-screen.md 11b.1): answer the
 * terminal's `[y/N]` ONLY now — after the flow compared both screens. `PAIR_ANSWER`
 * lets a flow refuse (`06-pair-declined`).
 */
const answer = typeof PAIR_ANSWER === "undefined" ? "y" : PAIR_ANSWER;
const response = http.get(`http://${MAESTRO_HOOKS}/pair-answer?answer=${answer}`);
if (!response.ok) {
  throw new Error(`pair-answer failed: ${response.status} ${response.body}`);
}
output.answered = json(response.body).answered;
