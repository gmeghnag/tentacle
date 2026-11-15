- **Moving a session is one live line, not fourteen transcript notices.** A hop's
  provisioning now takes the engine runtime's interactive single-line contract
  without needing a TTY: the hop hands it a throttled `liveLine`
  (≤ 1 update per 100 ms, the latest text always landing) that paints its own
  status row. One attach used to print `resolving…`, `injecting…`, ten
  `transfer ▓▓░ 10%…100%` lines and `verifying…` — each a separate transcript
  notice. The transcript now keeps only the engine's warnings and the one outcome
  line (`Moved to …` / `not moved: …`).
