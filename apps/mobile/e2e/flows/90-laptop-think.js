/** Flow 90: the laptop starts a fast reasoning stream on the long session. */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-prompt?session=${PERF_ID}&prompt=THINKHOLD%20FAST%2090`,
);
if (!response.ok) {
  throw new Error(`laptop-prompt failed: ${response.status} ${response.body}`);
}
output.thinking = "true";
