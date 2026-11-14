/**
 * The ONE icon seam (docs/feat/mobile-ui-polish.md Design 2, Owner Q4: SF Symbols).
 * Every screen names an icon by its SF Symbol name; how it is drawn is decided
 * only here.
 *
 * `expo-symbols` is not installed yet (Slice 1 Execution: adding a native
 * dependency needs a registry fetch + a dev-client rebuild this session could not
 * do), so the icons are drawn from plain views — geometric strokes for the
 * chrome glyphs (chevrons, plus, ellipsis, checkmark, xmark, arrow up, stop) and
 * a system-font glyph for the rest. Swapping in `<SymbolView name={name} …/>` is a
 * change to this file alone.
 */
import type { JSX } from "react";
import { Text, View } from "react-native";

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
  | "wifi.slash"
  | "clock"
  | "archivebox"
  | "square.and.pencil"
  | "bolt.fill"
  | "magnifyingglass"
  | "bubble.left"
  | "arrow.clockwise"
  | "trash";

/** The glyph drawn for an icon with no stroke drawing (the system font has these). */
const GLYPH: Partial<Record<IconName, string>> = {
  "slider.horizontal.3": "☰",
  folder: "▭",
  laptopcomputer: "⌨",
  terminal: "›_",
  "checkmark.circle": "✓",
  "exclamationmark.triangle": "!",
  "doc.on.doc": "⧉",
  "doc.on.clipboard": "⧉",
  "qrcode.viewfinder": "⌗",
  faceid: "☺",
  "wifi.slash": "⊘",
  clock: "◷",
  archivebox: "▤",
  "square.and.pencil": "✎",
  "bolt.fill": "⚡︎",
  magnifyingglass: "⌕",
  "bubble.left": "❝",
  "arrow.clockwise": "↻",
  trash: "⌫",
};

export interface IconProps {
  readonly name: IconName;
  readonly color: string;
  /** The glyph box, in points (SF Symbols' point size). */
  readonly size?: number;
  /** Stroke weight for the drawn glyphs. */
  readonly weight?: "regular" | "semibold" | "bold";
}

export function Icon({ name, color, size = 20, weight = "semibold" }: IconProps): JSX.Element {
  const stroke = Math.max(
    1.5,
    size * (weight === "bold" ? 0.13 : weight === "semibold" ? 0.11 : 0.08),
  );
  const box = {
    width: size,
    height: size,
    alignItems: "center",
    justifyContent: "center",
  } as const;
  switch (name) {
    case "chevron.left":
    case "chevron.right":
    case "chevron.down": {
      const arm = size * 0.42;
      const rotate =
        name === "chevron.left" ? "45deg" : name === "chevron.right" ? "-135deg" : "-45deg";
      const nudge =
        name === "chevron.left"
          ? { marginLeft: arm * 0.4 }
          : name === "chevron.right"
            ? { marginRight: arm * 0.4 }
            : { marginTop: -arm * 0.4 };
      return (
        <View style={box} pointerEvents="none">
          <View
            style={{
              width: arm,
              height: arm,
              borderLeftWidth: stroke,
              borderBottomWidth: stroke,
              borderColor: color,
              borderRadius: stroke / 2,
              transform: [{ rotate }],
              ...nudge,
            }}
          />
        </View>
      );
    }
    case "plus":
    case "xmark": {
      const len = size * 0.72;
      const bar = {
        position: "absolute",
        backgroundColor: color,
        borderRadius: stroke / 2,
      } as const;
      return (
        <View style={[box, name === "xmark" ? { transform: [{ rotate: "45deg" }] } : null]}>
          <View style={[bar, { width: len, height: stroke }]} />
          <View style={[bar, { width: stroke, height: len }]} />
        </View>
      );
    }
    case "ellipsis": {
      const dot = Math.max(3, size * 0.18);
      return (
        <View style={[box, { flexDirection: "row", gap: dot * 0.7 }]} pointerEvents="none">
          {[0, 1, 2].map((i) => (
            <View
              key={i}
              style={{ width: dot, height: dot, borderRadius: dot / 2, backgroundColor: color }}
            />
          ))}
        </View>
      );
    }
    case "checkmark":
      return (
        <View style={box} pointerEvents="none">
          <View
            style={{
              width: size * 0.32,
              height: size * 0.6,
              borderRightWidth: stroke,
              borderBottomWidth: stroke,
              borderColor: color,
              transform: [{ rotate: "45deg" }],
              marginTop: -size * 0.12,
            }}
          />
        </View>
      );
    case "arrow.up":
      return (
        <View style={box} pointerEvents="none">
          <View
            style={{
              position: "absolute",
              top: size * 0.18,
              width: size * 0.42,
              height: size * 0.42,
              borderLeftWidth: stroke,
              borderTopWidth: stroke,
              borderColor: color,
              transform: [{ rotate: "45deg" }],
            }}
          />
          <View
            style={{
              position: "absolute",
              top: size * 0.16,
              width: stroke,
              height: size * 0.68,
              backgroundColor: color,
              borderRadius: stroke / 2,
            }}
          />
        </View>
      );
    case "stop.fill":
      return (
        <View style={box} pointerEvents="none">
          <View
            style={{
              width: size * 0.55,
              height: size * 0.55,
              borderRadius: size * 0.1,
              backgroundColor: color,
            }}
          />
        </View>
      );
    default:
      return (
        <View style={box} pointerEvents="none">
          <Text
            allowFontScaling={false}
            style={{ color, fontSize: size * 0.8, lineHeight: size, fontWeight: "600" }}
          >
            {GLYPH[name] ?? "•"}
          </Text>
        </View>
      );
  }
}
