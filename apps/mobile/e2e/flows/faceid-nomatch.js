/**
 * Present a NON-matching face (docs/feat/mobile-lock.md F5/Step 0).
 *
 * REAL DEVICE ONLY: on the simulator the promise never resolves after a nomatch
 * (Step 0, two tries), so no flow in the suite depends on this — flow 07 drives
 * the cancel path through the Unlock button instead, which needs no Face ID
 * outcome. Kept as one command for the real-device checklist.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/faceid-nomatch`);
if (!response.ok) {
  throw new Error(`faceid-nomatch failed: ${response.status} ${response.body}`);
}
