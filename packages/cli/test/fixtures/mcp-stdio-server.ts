/**
 * A minimal stdio MCP server for tests: answers `initialize`, `tools/list` (one
 * tool, `echo`) and `ping`, one JSON message per line.
 */
const results: Record<string, unknown> = {
  initialize: { protocolVersion: "2024-11-05", capabilities: { tools: {} } },
  "tools/list": { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
  ping: {},
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
    if (typeof message.id === "number") {
      const result = results[message.method ?? ""];
      const reply =
        result !== undefined
          ? { jsonrpc: "2.0", id: message.id, result }
          : { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "not found" } };
      process.stdout.write(`${JSON.stringify(reply)}\n`);
    }
  }
}

export {};
