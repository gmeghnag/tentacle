/**
 * Present a matching face (docs/feat/mobile-lock.md Step 0). The system prompt
 * must be UP first: `authenticateAsync` registers the evaluation, then this
 * notification makes it succeed. That is why the flows assert `lock-screen`
 * before calling it — a match with no prompt would resolve nothing.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/faceid-match`);
if (!response.ok) {
  throw new Error(`faceid-match failed: ${response.status} ${response.body}`);
}
