/**
 * Flow 09: the LAPTOP answers the ask the phone is showing. The daemon takes the
 * first valid answer, so the phone's sheet gets `permission_resolved` and closes
 * WITHOUT sending anything (its own tap never comes).
 */
const response = http.get(`http://${MAESTRO_HOOKS}/laptop-answer?session=${ASK4_ID}&answer=allow`);
if (!response.ok) {
  throw new Error(`laptop-answer failed: ${response.status} ${response.body}`);
}
output.laptopAnswered = "allow";
