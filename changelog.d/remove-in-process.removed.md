- **Removed `--in-process` / `--no-worker`, and the silent fallback.** The local
  TUI has one session path now — the agent always runs in a worker thread over
  RPC (AGENTS §7). A flag that still passes either option is refused as an
  unknown option, and a worker that cannot start is a clear error naming the
  phase and reason (`tentacle runs its agent in a worker thread and has no
  fallback`, with the Bun version and reinstall hints and the daemon error log),
  exiting 1 before Ink mounts instead of silently degrading the TUI.
