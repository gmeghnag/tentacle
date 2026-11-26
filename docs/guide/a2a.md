# A2A

tentacle speaks [A2A](https://a2a-protocol.org) 1.0 (Agent2Agent, JSON-RPC) both
ways:

- **as a server**: other agents send tasks to a `tentacle serve`;
- **as a client**: the agent hands a sub-task to a remote A2A agent.

## Let other agents call tentacle (server)

Start `serve` with an A2A token of its own:

```sh
tentacle serve --a2a-token-command "cat ~/.config/tentacle/a2a-token"
# or --a2a-token <token>
```

| Endpoint | What it is |
| --- | --- |
| `GET /.well-known/agent-card.json` | The public agent card (no token). |
| `POST /a2a` | JSON-RPC: `SendMessage`, `SendStreamingMessage`, `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`, behind `Authorization: Bearer <A2A token>`. |

The A2A token is separate from `--token` and from the MCP token; without it A2A
is off.

How it behaves:

- A caller's `contextId` is a tentacle session (`a2a-default-<contextId>`), and
  each turn is a task that streams, can be cancelled and survives a restart; a
  task stays readable once its session is archived.
- **You are asked first.** The session's approvals come to you (TUI or phone).
  `--a2a-asks both` lets the caller answer tool approvals too; file approvals stay
  yours.
- `--a2a-workflows` lets a caller start workflow runs (off by default).

Try it:

```sh
curl -s http://127.0.0.1:4000/.well-known/agent-card.json
curl -s http://127.0.0.1:4000/a2a -H "Authorization: Bearer $A2A_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"SendMessage","params":{"message":{"messageId":"m1","role":"ROLE_USER","parts":[{"text":"list the files in this folder"}]}}}'
```

Design: [`docs/feat/a2a.md`](../feat/a2a.md).

## Hand a sub-task to a remote agent (client)

Declare the remote agent under `harnesses` in the config:

```jsonc
{
  "harnesses": {
    "bravo": {
      "adapter": "a2a",
      "card": "https://bravo.example.com/.well-known/agent-card.json",
      "tokenCommand": "security find-generic-password -s bravo-a2a -w",
      "description": "Reviews Go services in the bravo repo"
    }
  }
}
```

| Key | Meaning |
| --- | --- |
| `harnesses.<name>.adapter` | `a2a` for a remote A2A agent. |
| `.card` | The agent card URL (`https:`; `http:` only for localhost). |
| `.tokenCommand` | A command that **prints** the bearer token. Never put the token itself in the config. |
| `.description` | Your description, shown to the model first. |
| `.inputFrom` | Who answers the agent's questions: `user` (default), `parent` or `both`. |
| `.idleMinutes` | Hang guard: a run with no output this long is stopped (A2A default 30). |
| `.enabled` | Offer this agent (default on). |

How it behaves:

- The agent sees it as the sub-agent type `a2a:<name>`, described with the remote
  card's own text; the system prompt lists the agents it can call.
- **Every send is asked first** (the task and each reply), with secrets masked.
  Only the task text leaves the machine, and the report comes back marked as
  remote content. Cancelling the call sends `CancelTask`.
- A question from the remote agent reaches you like a permission prompt, in the
  terminal and on the phone; auto mode never answers it for you.
- The model may propose an agent nobody configured (a public `https` card that
  needs no credentials): you approve it once, and it lasts until `/clear`.
- Never offered in a pod.

Two tentacles work end to end this way: `serve --a2a-token` on one machine, a
`harnesses` entry on the other.

Design: [`docs/feat/a2a-client.md`](../feat/a2a-client.md).
