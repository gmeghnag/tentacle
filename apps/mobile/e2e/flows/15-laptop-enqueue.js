/** Flow 15: the LAPTOP queues a steer into the running turn (its own row). */
const response = http.get(
  `http://${MAESTRO_HOOKS}/laptop-enqueue?session=${OTHER_ID}&text=OTHER%20fifteen`,
);
if (!response.ok) {
  throw new Error(`laptop-enqueue failed: ${response.status} ${response.body}`);
}
output.rowId = json(response.body).id;
