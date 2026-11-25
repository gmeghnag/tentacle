A2A client (docs/feat/a2a-client.md C6/C11): a new blocking update
`question_request` (a remote agent's question to the person) answered by the
new method `session/answer_question` and settled by `permission_resolved`; a
new owner-only ask carried by the wire tool `a2a_add_agent`; `PushAsk.question`.
The number must move: an older client maps `a2a_add_agent` to an ordinary tool
ask its auto-accept would answer (the kind that forbids it is laptop-side), and
an older app would render a question push as an allow/deny sheet — push is not
gated by `initialize`, so only the version check at the app's next connect
stops a mixed pair.
