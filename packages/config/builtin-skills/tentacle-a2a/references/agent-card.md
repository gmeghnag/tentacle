# Writing and validating an A2A Agent Card

The card is a public JSON document that says who an agent is, where to call it,
how to authenticate and what it can do. Serve it at
`https://<host>/.well-known/agent-card.json` as `application/json`.

## Template (A2A 1.0)

```json
{
  "name": "Go review agent",
  "description": "Reviews Go pull requests against a style guide.",
  "version": "1.0.0",
  "supportedInterfaces": [
    {
      "url": "https://agents.example.com/a2a",
      "protocolBinding": "JSONRPC",
      "protocolVersion": "1.0"
    }
  ],
  "capabilities": { "streaming": true, "pushNotifications": false },
  "securitySchemes": {
    "bearer": { "httpAuthSecurityScheme": { "scheme": "Bearer" } }
  },
  "securityRequirements": [{ "schemes": { "bearer": { "list": [] } } }],
  "defaultInputModes": ["text/plain"],
  "defaultOutputModes": ["text/plain"],
  "skills": [
    {
      "id": "go-review",
      "name": "Go review",
      "description": "Review a Go diff and list problems with file and line.",
      "tags": ["go", "review"],
      "examples": ["Review this diff for error handling"]
    }
  ]
}
```

## Fields

- `name`, `description`, `version`: required, short and concrete. Other agents
  choose by `description` and the skills' text.
- `supportedInterfaces`: where and how to call. `protocolBinding` is `JSONRPC`,
  `GRPC` or `HTTP+JSON`; the first entry is preferred.
- `capabilities`: say `streaming: true` only if the agent really streams.
- `securitySchemes` + `securityRequirements`: how a caller authenticates. Never
  put a token or key in the card: it is public.
- `defaultInputModes`, `defaultOutputModes`: media types.
- `skills`: at least one; each has `id`, `name`, `description`, `tags` and,
  usefully, `examples`.
- Optional: `provider`, `documentationUrl`, `iconUrl`, `signatures`.

## Validate

1. It is valid JSON: `curl -s <card-url> | jq .`
2. Required fields present:
   `curl -s <card-url> | jq '{name, version, supportedInterfaces, skills}'`
3. Every interface `url` is `https` (plain `http` only for localhost) and
   reachable.
4. The security scheme matches what the endpoint really requires: a call with no
   credentials is refused.
5. One real call works (see the `curl` example in the skill).

## What tentacle requires of a remote agent's card

To be used as `a2a:<name>`: a `JSONRPC` interface with `protocolVersion` 1.x,
on the same origin as the card URL (the only place the token is sent),
`capabilities.streaming: true`, no redirect to another origin and no
`user:password` in the URL.
