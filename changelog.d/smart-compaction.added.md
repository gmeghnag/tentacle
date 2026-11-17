- **The pure pruner for lossless-first context pruning (`docs/feat/smart-compaction.md`, slice
  S1).** `packages/agent/src/prune.ts` computes — from the stored history, never touching it — which
  messages the model's copy may replace and by what stub: an `fs_read` result a later read or a
  successful edit superseded (R1); the payload of a successful `fs_write`/`fs_edit`/`fs_multi_edit`,
  whose file on disk is the truth (R2); a long `shell`/`shell_output` result already acted on,
  keeping its exit code and head/tail (R3); a spilled result's preview when the full output is on
  disk (R4); a result byte-identical to a later one (R5). User and assistant prose is never pruned,
  nor the most recent rounds, nor skill and `context_reset` results, and every stub says how to get
  the content back and carries the `⟪pruned by tentacle` sentinel that the write tools will refuse.
  `applyPrune` returns a new array, so the stored history, the session log and resume stay
  byte-identical; no provider, protocol or on-disk format changes. Not yet wired into the agent
  loop, so behaviour is unchanged in this release.
