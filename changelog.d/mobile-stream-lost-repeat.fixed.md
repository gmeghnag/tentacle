- **Mobile: the "stream was lost" notice no longer stacks or survives a completed
  turn.** A turn's stream that throws once per reconnect now leaves ONE notice
  instead of one per throw, and that notice is retracted as soon as the same
  turn is seen completing — so a reply that arrived is never followed by "that
  turn's stream was lost". The app log's `qtrace` `turn-end` line for such a
  loss now also carries the throwing error's class and numeric code, so the next
  device capture names the trigger (`docs/fix/mobile-stream-lost-repeat.md`).
