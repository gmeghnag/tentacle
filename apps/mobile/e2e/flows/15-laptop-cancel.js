/** Flow 15: the laptop stops the turn, so ITS queued row comes back to itself. */
const response = http.get(`http://${MAESTRO_HOOKS}/laptop-cancel?session=${OTHER_ID}`);
if (!response.ok) {
  throw new Error(`laptop-cancel failed: ${response.status} ${response.body}`);
}
output.cancelled = "true";
