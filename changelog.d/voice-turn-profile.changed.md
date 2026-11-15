- **Voice turns answer sooner, and are written to be heard.** A prompt or a
  mid-turn steer can now say it came from voice mode, carrying that edge's own
  "reasoning off for spoken replies" setting. The turn then reasons off for the
  rounds before its first tool call — a spoken reply wants an answer now, while
  real work still reasons as configured once the model asks for a tool — and its
  requests carry one short instruction that the person is listening, not
  reading. Both live on the outgoing request alone: the stored conversation,
  `session/log` and a `serve` daemon's files never contain them. The setting is
  per edge and read at send time, so a phone and a terminal on one session each
  send their own. On OpenAI-compatible endpoints it asks for
  `reasoning_effort: none` with `enable_thinking: false`, retrying once without
  them (and remembering) if the endpoint rejects them; Anthropic is unchanged,
  and a pod's tunneled model call carries the wish back to the laptop that owns
  the model. A turn that is not a voice one is untouched.
