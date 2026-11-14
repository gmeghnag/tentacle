/**
 * The image sniffer moved to `@tentacle/core` (docs/feat/mobile-compose.md D6):
 * the phone needs the same bytes-decide-the-type rule as the TUI, and a copy
 * would drift. This file stays a RE-EXPORT so no TUI import changes — the TUI
 * is being reworked by `app-decomposition`, and touching its call sites would
 * conflict. The TUI's own tests, unchanged and green, are the proof the move is
 * behaviour-preserving.
 */
export { HEIF_BRANDS, IMAGE_HEAD_BYTES, type SniffResult, sniffImageType } from "@tentacle/core";
