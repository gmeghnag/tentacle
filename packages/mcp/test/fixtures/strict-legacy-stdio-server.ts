/**
 * A strict legacy (2025-06-18) stdio MCP server, for the era-probe tests.
 * MODE=exit-on-unknown: exits when the first message is not `initialize` (the
 * rmcp <= 0.8 behaviour). MODE=reply-then-exit: answers that first request
 * with an error, then exits. MODE=strict-notify: ignores unknown
 * pre-`initialize` requests, but exits on any pre-`initialize` notification.
 */
const mode = process.env.MODE ?? "exit-on-unknown";
let initialized = false;
const send = (message: unknown): void => {
  process.stdout.write(`${JSON.stringify(message)}\n`);
};
let buffer = "";
for await (const chunk of Bun.stdin.stream()) {
  buffer += new TextDecoder().decode(chunk);
  const lines = buffer.split("\n");
  buffer = lines.pop() ?? "";
  for (const line of lines) {
    if (line.trim() === "") {
      continue;
    }
    const message = JSON.parse(line) as { id?: number; method?: string };
    if (!initialized && message.method !== "initialize") {
      if (mode === "exit-on-unknown") {
        process.exit(1);
      }
      if (mode === "reply-then-exit" && message.id !== undefined) {
        send({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32600, message: "not initialized" },
        });
        process.exit(1);
      }
      if (message.id === undefined && message.method !== "notifications/initialized") {
        process.exit(1);
      }
      continue;
    }
    if (message.method === "initialize") {
      initialized = true;
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } },
      });
    } else if (message.method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
      });
    } else if (message.method === "ping") {
      send({ jsonrpc: "2.0", id: message.id, result: {} });
    }
  }
}

export {};
