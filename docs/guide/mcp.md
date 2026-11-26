# MCP

tentacle speaks the [Model Context Protocol](https://modelcontextprotocol.io) both
ways:

- **as a client**: it connects to MCP servers and offers their tools to the agent;
- **as a server**: a `tentacle serve` can be called by Claude Code and other MCP
  clients, which start and steer tentacle sessions.

## Use MCP servers (client)

Add servers under `mcpServers` in `~/.config/tentacle/config.jsonc` (or a
project's config, or a profile). A server is either spawned (`stdio`) or reached
over Streamable HTTP (`http`):

```jsonc
{
  "mcpServers": {
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "…" }
    },
    "docs": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": { "Authorization": "Bearer …" }
    }
  }
}
```

| Key | Meaning |
| --- | --- |
| `mcpServers.<name>.type` | `stdio` (spawned) or `http` (Streamable HTTP). |
| `.command`, `.args`, `.cwd`, `.env.*` | How a `stdio` server is spawned. |
| `.url`, `.headers.*` | The endpoint and headers of an `http` server. |
| `.readOnlyTools` | Which of its tools are reads: `hint` (default: those the server marks `readOnlyHint`), `none`, or a list of tool names. |

How it behaves:

- Each tool reaches the agent as `mcp__<server>__<tool>`, so servers never clash
  with each other or with tentacle's own tools.
- **Every MCP call goes through the permission prompt.** `readOnlyTools` does
  not skip it: it only lets read calls of one server run side by side.
- `/mcp` in the TUI (and Session info on the phone) lists the servers with their
  state and switches a server off or on **for this session**, also before the
  first message.
- A server's stderr is captured, never printed over the TUI.
- On `run`/`attach` the pod uses its own config, so the MCP servers that act on
  the workspace run next to the code. A `serve` session gets the MCP servers of
  the machine the `serve` runs on.

Every key, with its full card: `tentacle explain mcpServers`, or the table in
[configuration.md](configuration.md).

## Let MCP clients use tentacle (server)

Start `serve` with an MCP token of its own:

```sh
tentacle serve --mcp-token-command "cat ~/.config/tentacle/mcp-token"
# or --mcp-token <token>
```

`serve` then answers `POST /mcp` (Streamable HTTP) behind
`Authorization: Bearer <MCP token>`. The token is separate from `--token` and from
the A2A token; without it MCP is off. At start `serve` prints the line that
registers it in Claude Code:

```sh
claude mcp add --transport http tentacle http://127.0.0.1:4000/mcp \
  --header "Authorization: Bearer <token>"
```

The tools a client gets:

| Tool | What it does |
| --- | --- |
| `session_start` | Start a session with a first message (an optional `key` makes a retry safe). |
| `session_send` | Steer or continue a session. |
| `session_status` | Read a session's state; `waitSeconds` waits for a change. |
| `session_answer` | Answer a tool approval (only with `--mcp-asks both`, once, never permanently). |
| `session_cancel` | Stop the running turn. |
| `session_list` | List the sessions. |

Clients that support MCP tasks get one task per turn instead, which survives a
restart. A session started over MCP is a normal tentacle session: it shows up on
your phone, and **you** answer its approvals there unless `--mcp-asks both` lets
the caller answer too (file approvals stay yours).

Design and details: [`docs/feat/serve-mcp-server.md`](../feat/serve-mcp-server.md).
