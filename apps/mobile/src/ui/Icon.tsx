/**
 * The ONE icon seam (docs/feat/mobile-ui-polish.md Design 2, Owner Q4: SF Symbols).
 * Every screen names an icon by its SF Symbol name and this file draws it with
 * `expo-symbols`' native `SymbolView` (`IconName` is checked against
 * `SFSymbol`, so a misspelt name fails the typecheck). Render only.
 */
import { SymbolView } from "expo-symbols";
import type { JSX } from "react";
import { View } from "react-native";

export type IconName =
  | "chevron.left"
  | "chevron.right"
  | "chevron.down"
  | "line.3.horizontal"
  | "ellipsis"
  | "plus"
  | "xmark"
  | "checkmark"
  | "arrow.up"
  | "stop.fill"
  | "slider.horizontal.3"
  | "gearshape"
  | "folder"
  | "laptopcomputer"
  | "terminal"
  | "checkmark.circle"
  | "exclamationmark.triangle"
  | "doc.on.doc"
  | "doc.on.clipboard"
  | "qrcode.viewfinder"
  | "faceid"
  | "touchid"
  | "lock.fill"
  | "lock.shield.fill"
  | "wifi.slash"
  | "clock"
  | "archivebox"
  | "square.and.pencil"
  | "bolt.fill"
  | "magnifyingglass"
  | "bubble.left"
  | "arrow.clockwise"
  | "arrow.down"
  | "photo"
  | "square.and.arrow.up"
  | "hand.raised"
  | "trash"
  | "mic"
  | "mic.fill"
  | "waveform"
  | "speaker.wave.2"
  | "stop.circle"
  /** A context reset / a compaction on the step rail (docs/feat/mobile-reset-in-timeline.md). */
  | "arrow.counterclockwise"
  | "arrow.down.right.and.arrow.up.left"
  /** A pinned session in the sessions list (docs/feat/mobile-session-actions.md). */
  | "pin"
  /** The hub's Tools item (docs/feat/mobile-hub-tools.md): what the sheet switches. */
  | "powerplug"
  /** The Artifacts gallery (docs/feat/mobile-gallery-polish.md): its look toggle and kind symbols. */
  | "square.grid.2x2"
  | "list.bullet"
  | "scribble"
  | "globe"
  | "doc.richtext"
  | "doc.text"
  | "doc.plaintext"
  | "chart.bar.xaxis"
  /** The hub's Workflows item (docs/fix/workflows-ux.md D6): owner, 2026-11-24. A workflow step asking, too. */
  | "point.topleft.down.to.point.bottomright.curvepath"
  | "doc"
  /** A sub-agent asking (docs/fix/mobile-ask-surfaces.md). */
  | "arrow.triangle.branch"
  /**
   * A workflow step's marker glyphs (docs/fix/workflows-ux.md D4, mockup
   * `markers-v2.html`): `ok` ✓, `error` ✕ (owner: `error-icon.html`), `running`
   * ▶, `ask` ?, `stopped` ■ (Q5), `skipped` ». `later`/`unknown` have NO glyph on
   * purpose — the owner's plain soft disc — so `workflow-marker.ts` maps them to
   * `null` rather than to a name here.
   */
  | "multiply"
  | "questionmark"
  | "play.fill"
  | "chevron.forward.2"
  | "chevron.up";

export interface IconProps {
  readonly name: IconName;
  readonly color: string;
  /** The glyph box, in points (SF Symbols' point size). */
  readonly size?: number;
  /**
   * The SF Symbol weight. `thin`/`light` join the three heavier ones for the
   * header's thin glyphs (docs/feat/mobile-chrome.md A1); `expo-symbols`'
   * `SymbolWeight` carries both.
   */
  readonly weight?: "thin" | "light" | "regular" | "semibold" | "bold";
}

export function Icon({ name, color, size = 20, weight = "semibold" }: IconProps): JSX.Element {
  return (
    <SymbolView
      name={name}
      tintColor={color}
      size={size}
      weight={weight}
      resizeMode="scaleAspectFit"
      pointerEvents="none"
      style={{ width: size, height: size }}
      // iOS-only app; elsewhere keep the box so layouts do not shift.
      fallback={<View style={{ width: size, height: size }} />}
    />
  );
}
