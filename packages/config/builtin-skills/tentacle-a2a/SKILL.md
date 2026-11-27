---
name: tentacle-a2a
description: Use when the user asks about A2A (Agent2Agent) or Agent Cards - exposing a tentacle serve to other agents, configuring or testing a remote agent in tentacle, or writing and validating an Agent Card for any agent.
---
# A2A with tentacle

A2A 1.0 over JSON-RPC, in both directions. To write or check an Agent Card
(for any agent, not only tentacle) read `references/agent-card.md` with
`fs_read` first.

## Rules

- Tokens come from a command (`--a2a-token-command`, `tokenCommand`), never a
  literal in a config file or a chat message.
- Never read or print `config.jsonc`; use `tentacle config get <key>` /
  `tentacle explain <key>`.

## Expose a serve to other agents

```sh
tentacle serve --host 127.0.0.1 --port 4000 --a2a-token-command <cmd>
```

- Without an A2A token, A2A is off. It is a token of its own, never `--token`.
- The public card is at `/.well-known/agent-card.json`; calls go to `POST /a2a`
  with `Authorization: Bearer <A2A token>`.
- The owner is asked first. `--a2a-asks both` lets the caller answer tool asks
  too (file approvals stay owner-only); `--a2a-workflows` lets it start workflow
  runs (default off).
- A caller's `contextId` is one session; each message is a task. Tasks survive a
  restart.
- A client on another host needs a reachable address and TLS (`--tls-cert`,
  `--tls-key`) or a private network; a non-loopback `--host` also needs `--token`.

Serve flags:

<!-- generated:a2a-serve-flags -->
- `--a2a-token`
- `--a2a-token-command`
- `--a2a-asks`
- `--a2a-workflows`
<!-- /generated:a2a-serve-flags -->

## Use a remote agent from tentacle

```sh
tentacle config set harnesses.<name>.adapter a2a
tentacle config set harnesses.<name>.card https://<host>/.well-known/agent-card.json
tentacle config set harnesses.<name>.tokenCommand "<command printing the token>"
```

`<name>` is lowercase letters, digits and `-`, at most 32. The agent then offers
`agent_task` the type `a2a:<name>`. Each send asks the user first, only the task
text leaves the machine, and the report is framed as remote data. The card must
offer a JSON-RPC 1.x interface on its own origin and `capabilities.streaming`.

The keys:

<!-- generated:a2a-config -->
- `harnesses`: Other agent harnesses that can run a sub-agent, keyed by instance name.
- `harnesses.*`: One harness instance's settings (`claude-code`, or a remote `a2a` agent).
- `harnesses.*.adapter`: Which adapter the instance runs on; defaults to the instance name.
- `harnesses.*.card`: An `a2a` agent's card URL (`https:`; `http:` only for localhost).
- `harnesses.*.tokenCommand`: A command printing an `a2a` agent's bearer token (never the token itself).
- `harnesses.*.description`: Your description of an `a2a` agent, shown to the model first and listed in the system prompt's environment block.
- `harnesses.*.inputFrom`: Who answers an `a2a` agent's questions: `user` (default), `parent` or `both`.
- `harnesses.*.enabled`: Offer this harness's sub-agent type (default on).
- `harnesses.*.command`: The executable to run (unset: `claude`).
- `harnesses.*.model`: The model when an `agent_task` call names none (unset: `opus`).
- `harnesses.*.idleMinutes`: Hang guard: a run with no output for this many minutes is stopped (unset: 15; `a2a`: 30).
<!-- /generated:a2a-config -->

## Test an agent with curl

`TOKEN` holds the bearer token (from a secret store, not typed into the chat).

```sh
curl -s https://<host>/.well-known/agent-card.json
curl -s https://<host>/a2a \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -H "A2A-Version: 1.0" \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"messageId":"m1","role":"ROLE_USER","parts":[{"text":"Say hello"}]}}}'
```

- A call without the `A2A-Version: 1.0` header is refused (error `-32009`).
- `401` means a missing or wrong token (a request with a browser `Origin` is
  refused too).
- Other methods: `SendStreamingMessage` (server-sent events), `GetTask`,
  `ListTasks`, `CancelTask`, `SubscribeToTask`. Pass `contextId` in the message
  to continue a conversation.
