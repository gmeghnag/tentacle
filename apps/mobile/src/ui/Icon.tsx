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
  | "ellipsis"
  | "plus"
  | "xmark"
  | "checkmark"
  | "arrow.up"
  | "stop.fill"
  | "slider.horizontal.3"
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
  | "hand.raised"
  | "trash";

export interface IconProps {
  readonly name: IconName;
  readonly color: string;
  /** The glyph box, in points (SF Symbols' point size). */
  readonly size?: number;
  /** The SF Symbol weight. */
  readonly weight?: "regular" | "semibold" | "bold";
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
