# Remote: `serve`, `connect`, A2A and MCP

**`serve` + `connect`: on a remote host.** Run the agent as a daemon on one
machine and drive it from another machine's TUI:

```sh
tentacle serve --host 127.0.0.1 --port 4000 [--token T | --token-command CMD]
tentacle connect ws://host:4000 [--token T] [--resume [id] | --continue]
```

Quitting `connect` detaches: the session, a running turn and its background
jobs keep going on the daemon, and the exit line says how to come back
(`--resume <id>`). `--resume` picks one of the daemon's sessions (or names
one; an ended session is reopened), `--continue` takes the newest. In the TUI,
`/sessions` lists the daemon's sessions to switch to or delete (`x` twice),
`/close` ends the session for every device and quits, `/clear` ends it and
starts a fresh one. `connect` keeps no laptop copy: the daemon's record is
the truth.

A `serve` with no reachable address can be driven the way a paired phone does
it, through the mobile relay: run `tentacle pair` on the host, `tentacle
connect --pair '<tentacle://pair?…>'` once on the laptop (answer `y` on the host
after comparing the code), then `tentacle connect <name>` — direct addresses
are tried first, the relay last. The laptop gets a phone's rights on that one
project; its key is kept in the macOS Keychain, else a `0600` file. `connect
--forget <name>` drops it here; revoke it on the host with `tentacle devices
revoke`.

A non-loopback `--host` requires a token. TLS: `--tls-cert`/`--tls-key` on
`serve`; `--ca-cert FILE` on `connect` for a private CA. Details:
[`docs/architecture/F3-remote-control.md`](../architecture/F3-remote-control.md).

**A2A: other agents can call a `serve`.** With `--a2a-token T` (or
`--a2a-token-command CMD`) the daemon also speaks
[A2A](https://a2a-protocol.org) 1.0 over JSON-RPC: the public agent card at
`/.well-known/agent-card.json`, and `POST /a2a` (`SendMessage`,
`SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`,
`SubscribeToTask`) behind `Authorization: Bearer <A2A token>`. It is a token of
its own, never `--token`; without it A2A is off. A caller's `contextId` is a
session (`a2a-default-<contextId>`) and each turn is a task; tasks survive a
restart and stay readable once their session is archived. The owner is always
asked first: `--a2a-asks both` lets the caller answer tool asks too (file
approvals stay owner-only), and `--a2a-workflows` lets it start workflow runs
(off by default). Design: [`docs/feat/a2a.md`](../feat/a2a.md).

**A2A client: hand a sub-task to another agent.** Configure a remote agent
under `harnesses.<name>` with `"adapter": "a2a"`, its `card` URL and an optional
`tokenCommand` (a command that prints the token, never the token itself); the
model can then start it as the sub-agent type `a2a:<name>`. Each send asks you
first, only the task text leaves the machine, and the report comes back framed
as remote data. A question from the remote agent reaches you as a prompt (and a
phone notification), and cancelling the call sends `CancelTask`. Two tentacles
work end to end this way (`serve --a2a-token` on one side). Design:
[`docs/feat/a2a-client.md`](../feat/a2a-client.md).

**MCP server: Claude Code and other MCP clients can call a `serve`.** With
`--mcp-token T` (or `--mcp-token-command CMD`) the daemon also answers
`POST /mcp` (Streamable HTTP) behind `Authorization: Bearer <MCP token>`, a
token of its own (never `--token` or the A2A one); without it MCP is off.
Tools: `session_start`, `session_send`, `session_status` (`waitSeconds` waits),
`session_answer`, `session_cancel`, `session_list`. A session it starts is
`mcp-default-<uuid>` and shows up on your phone like any other. The owner is
asked first: `--mcp-asks both` lets the caller answer tool asks too (file
approvals stay owner-only). `serve` prints the line to register it:

```
claude mcp add --transport http tentacle http://127.0.0.1:4000/mcp --header "Authorization: Bearer <token>"
```

Design: [`docs/feat/serve-mcp-server.md`](../feat/serve-mcp-server.md).

