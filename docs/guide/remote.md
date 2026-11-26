# Remote: `serve` and `connect`

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
it, through the mobile relay ([relay.md](relay.md)): run `tentacle pair` on the host, `tentacle
connect --pair '<tentacle://pair?…>'` once on the laptop (answer `y` on the host
after comparing the code), then `tentacle connect <name>` — direct addresses
are tried first, the relay last. The laptop gets a phone's rights on that one
project; its key is kept in the macOS Keychain, else a `0600` file. `connect
--forget <name>` drops it here; revoke it on the host with `tentacle devices
revoke`.

A non-loopback `--host` requires a token. TLS: `--tls-cert`/`--tls-key` on
`serve`; `--ca-cert FILE` on `connect` for a private CA. Details:
[`docs/architecture/F3-remote-control.md`](../architecture/F3-remote-control.md).

**A2A, MCP, the relay and apps** each have their own guide: other agents calling
a `serve` or being called by it — [a2a.md](a2a.md); Claude Code and other MCP
clients driving a `serve`, and MCP servers in tentacle — [mcp.md](mcp.md); a
`serve` with no open port, pairing a phone or a laptop — [relay.md](relay.md);
pages the agent publishes — [apps.md](apps.md).
