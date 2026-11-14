/**
 * `_unlock`'s first beat (docs/feat/mobile-lock.md Step 0): enrol a face on the
 * simulator so `authenticateAsync` can resolve success at all. Idempotent — the
 * harness runs it once per boot, and a second call just re-posts the same state.
 */
const response = http.get(`http://${MAESTRO_HOOKS}/faceid-enroll`);
if (!response.ok) {
  throw new Error(`faceid-enroll failed: ${response.status} ${response.body}`);
}
