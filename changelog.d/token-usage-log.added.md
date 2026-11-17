- **Per-round token usage log.** Every model round's spend (input, output, the cached
  part of the input when the provider reports it, the model id, and how many
  messages the request carried) is recorded as a non-critical `usage` entry in the
  session log, and `tentacle logs <uid> --usage` prints it as a per-round table with
  totals — plain text, no colour, `—` for anything the provider did not measure.
