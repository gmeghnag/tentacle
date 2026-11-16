/**
 * Flow 25's switch step (docs/feat/session-capabilities.md S5): the tap on the
 * `demo` server's switch must be the COMPUTER's state, not just what the phone
 * drew (plan P9). Reads the daemon's own switches of the session through the
 * harness (`session-capabilities`: an attach's snapshot), and checks `demo` is
 * hidden (`EXPECT=off`) or visible again (`EXPECT=on`).
 */
const response = http.get(`http://${MAESTRO_HOOKS}/session-capabilities?session=${INFO_ID}`);
if (!response.ok) {
  throw new Error(`session-capabilities failed: ${response.status} ${response.body}`);
}
const caps = json(response.body).capabilities;
if (caps === null) {
  throw new Error("the daemon reported no MCP/skill switches for the session");
}
const off = caps.disabledMcp.indexOf("demo") !== -1;
if (EXPECT === "off" && !off) {
  throw new Error(
    `the phone's switch never reached the computer: disabledMcp is ${JSON.stringify(caps.disabledMcp)}`,
  );
}
if (EXPECT === "on" && off) {
  throw new Error("turning demo back on never reached the computer: it is still disabled");
}
