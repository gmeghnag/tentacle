// Ambient types for `marked-terminal` v7, which ships no declarations.
declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";
  export function markedTerminal(
    options?: Record<string, unknown>,
    highlightOptions?: Record<string, unknown>,
  ): MarkedExtension;
}
