/**
 * The components whose style metrics the kit reads (docs/feat/mobile-mockup-kit.md
 * Slice 1b). `styles: true` ⇒ the file MUST have one top-level
 * `StyleSheet.create` (else the generator throws: a moved/renamed component is
 * loud). `styles: false` ⇒ only its SCREAMING_CASE module consts are read (a
 * component styled inline, e.g. `HeaderDot`'s `SIZE`).
 *
 * Not here, styled only by inline JSX objects (no named metric to read):
 * `Pill`, `PillButton`, `Banner`, `EmptyState` — the kit maps those by hand and
 * calibration is their net.
 */
export interface ManifestEntry {
  readonly id: string;
  readonly file: string;
  readonly styles: boolean;
}

export const MANIFEST: readonly ManifestEntry[] = [
  { id: "step", file: "apps/mobile/src/ui/StepNode.tsx", styles: true },
  { id: "composer", file: "apps/mobile/src/ui/Composer.tsx", styles: true },
  { id: "sheet", file: "apps/mobile/src/ui/Sheet.tsx", styles: true },
  { id: "hub-fan", file: "apps/mobile/src/ui/HubFan.tsx", styles: true },
  { id: "hub-button", file: "apps/mobile/src/ui/FloatingActivity.tsx", styles: true },
  { id: "row", file: "apps/mobile/src/ui/Row.tsx", styles: true },
  { id: "band", file: "apps/mobile/src/ui/BandSection.tsx", styles: true },
  { id: "screen-header", file: "apps/mobile/src/ui/ScreenHeader.tsx", styles: true },
  { id: "glass-button", file: "apps/mobile/src/ui/GlassButton.tsx", styles: true },
  { id: "code-block", file: "apps/mobile/src/ui/CodeBlock.tsx", styles: true },
  { id: "header-dot", file: "apps/mobile/src/ui/HeaderDot.tsx", styles: false },
  {
    id: "transcript-row",
    file: "apps/mobile/src/screens/transcript/TranscriptRow.tsx",
    styles: true,
  },
  { id: "markdown", file: "apps/mobile/src/screens/transcript/Markdown.tsx", styles: true },
  { id: "permission-sheet", file: "apps/mobile/src/screens/PermissionSheet.tsx", styles: true },
  { id: "computers", file: "apps/mobile/src/screens/ComputersScreen.tsx", styles: true },
  { id: "sessions-drawer", file: "apps/mobile/src/screens/SessionsDrawer.tsx", styles: true },
];
