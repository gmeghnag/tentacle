/**
 * A minimal stdio MCP server for tests: answers `initialize`, `tools/list` (one
 * tool, `echo`) and `ping`, one JSON message per line. A `tools/call` of `echo`
 * records the call (and answers with it), so a test can prove a gated tool did
 * NOT reach the server.
 *
 * Test knobs, all opt-in through the environment (a spec's `env` is the only
 * channel, so a spec that sets none behaves exactly as before):
 *  - `MCP_PID_FILE`: write this process's pid there at startup (a shutdown test
 *    then checks `process.kill(pid, 0)` throws).
 *  - `MCP_CALL_LOG`: append one line per `tools/call` (the call's name + a
 *    sorted env KEY list, so a test can prove no secret reached the child).
 *  - `MCP_STDERR_LINES`: emit that many lines on stderr at startup.
 *  - `MCP_INIT_DELAY_MS`: answer `initialize` only after that delay.
 *  - `MCP_EXIT_AFTER_INIT`: exit right after answering `initialize` (a server that
 *    dies during its handshake).
 *  - `MCP_EXIT_AFTER_TOOLS_ONCE`: exit right after answering `tools/list`, but
 *    only the FIRST time (a marker file beside `MCP_PID_FILE`): a server that
 *    connects fully, crashes once, and stays up when respawned.
 *  - `MCP_CRASH_ON_CALL_ONCE`: die during the FIRST `tools/call` (before
 *    answering it), once. A test then decides exactly when the crash happens —
 *    no race with the connect.
 */
import { appendFileSync, existsSync, writeFileSync } from "node:fs";

const pidFile = process.env.MCP_PID_FILE;
if (pidFile) {
  writeFileSync(pidFile, String(process.pid));
}
const callLog = process.env.MCP_CALL_LOG;
const stderrLines = Number(process.env.MCP_STDERR_LINES ?? "0");
for (let i = 0; i < stderrLines; i++) {
  process.stderr.write(`stderr line ${i}\n`);
}
const initDelayMs = Number(process.env.MCP_INIT_DELAY_MS ?? "0");
const exitAfterInit = process.env.MCP_EXIT_AFTER_INIT === "1";
const exitAfterTools = process.env.MCP_EXIT_AFTER_TOOLS === "1";
/** Crash once, then stay up: the marker makes only the first generation die. */
const crashOnce = process.env.MCP_EXIT_AFTER_TOOLS_ONCE === "1";
const crashOnCall = process.env.MCP_CRASH_ON_CALL_ONCE === "1";
const crashMarker = pidFile ? `${pidFile}.crashed` : undefined;

const results: Record<string, unknown> = {
  initialize: { protocolVersion: "2024-11-05", capabilities: { tools: {} } },
  "tools/list": { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
  ping: {},
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    const message = JSON.parse(line) as {
      id?: number;
      method?: string;
      params?: { name?: string; arguments?: Record<string, unknown> };
    };
    if (message.method === "tools/call") {
      // A demand-driven crash (the supervised-restart test): die before answering.
      if (crashOnCall && crashMarker && !existsSync(crashMarker)) {
        writeFileSync(crashMarker, "1");
        process.exit(7);
      }
      if (callLog) {
        appendFileSync(
          callLog,
          `${JSON.stringify({
            name: message.params?.name,
            args: message.params?.arguments,
            envKeys: Object.keys(process.env).sort(),
          })}\n`,
        );
      }
      if (message.params?.name === "echo") {
        const args = message.params?.arguments ?? {};
        if (typeof message.id === "number") {
          process.stdout.write(
            `${JSON.stringify({
              jsonrpc: "2.0",
              id: message.id,
              result: { content: [{ type: "text", text: JSON.stringify(args) }] },
            })}\n`,
          );
        }
      }
      continue;
    }
    if (typeof message.id === "number") {
      if (message.method === "initialize" && initDelayMs > 0) {
        await sleep(initDelayMs);
      }
      const result = results[message.method ?? ""];
      const reply =
        result !== undefined
          ? { jsonrpc: "2.0", id: message.id, result }
          : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } };
      process.stdout.write(`${JSON.stringify(reply)}\n`);
      if (message.method === "initialize" && exitAfterInit) {
        process.exit(0);
      }
      if (message.method === "tools/list" && exitAfterTools) {
        process.exit(0);
      }
      if (message.method === "tools/list" && crashOnce && crashMarker && !existsSync(crashMarker)) {
        writeFileSync(crashMarker, "1");
        process.exit(0);
      }
    }
  }
}
