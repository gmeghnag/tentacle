- **A `serve` session has the MCP tools of the machine it runs on.** A phone or
  `connect` session is hosted by `tentacle serve`, which connected no MCP server
  before this: a phone turn had none of the configured tools and `/mcp` answered
  with an empty list. The daemon now connects the host's `mcpServers` once, in
  the background (one connection set per daemon, which is one per project — a
  `serve` hosts exactly one), registers their tools into every session it builds
  — including one restored from the store, or built while the handshake is still
  in flight — and answers `mcp/status`, so `connect`'s `/mcp` lists them. Each
  tool keeps `permission: "ask"`: a deny reaches no server (pinned by a test with
  a mutation on the gate). A server that crashes is respawned with backoff (1 s,
  2 s, 4 s … up to 60 s, giving up after five consecutive failures, and a spawn
  that stays up ten minutes resets the count) on both hosts, and the tools it
  contributed keep working across the respawn, so a long-lived daemon — which
  nobody can restart from a phone — heals itself. A server's stderr is capped at
  50 lines then one "further stderr suppressed", a name clash with a built-in is
  reported instead of silently skipped, and a connect failure names the server.
