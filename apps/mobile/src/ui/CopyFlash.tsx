/**
 * The copy confirmation pill (docs/feat/mobile-copy-text.md D3): a floating
 * capsule above the composer saying what a long-press just did — `✓ Copied ·
 * Select text` — or why there was nothing (`No text to copy`, `Couldn't copy`).
 *
 * Absolutely positioned, never in the transcript's flow: a pill that took
 * layout would change `contentGrew` (`follow.ts`) and make the list jump every
 * time somebody copied a message. Glyph + word, never colour alone (the owner is
 * colour-blind): the `✓` is `palette.label`, not a green-only signal.
 *
 * Render only — whether it is up is `copyFlashShown` (`message-copy.ts`), and the
 * screen owns the timer.
 */
import type { JSX } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import type { MessageCopy } from "../message-copy.ts";
import { type Palette, radius, shadow, size, space, typography } from "../theme.ts";
import { Icon } from "./Icon.tsx";
import { Text } from "./Text.tsx";

export interface CopyFlashProps {
  readonly outcome: MessageCopy;
  readonly palette: Palette;
  /** Opens the "Select text" sheet; absent = the pill offers no action (tests, other callers). */
  readonly onSelect?: () => void;
}

export function CopyFlash({ outcome, palette, onSelect }: CopyFlashProps): JSX.Element {
  // Only a REAL copy can be opened and selected: there is no text behind the
  // other two states, so offering "Select text" there would open an empty sheet.
  const selectable = outcome.kind === "copy" && onSelect !== undefined;
  return (
    <View
      testID="copy-flash"
      // The pill is an announcement, not a control: VoiceOver reads it, and only
      // the "Select text" inside it is a button.
      accessibilityLiveRegion="polite"
      style={[
        styles.pill,
        // One step above the page in both palettes: readable, never a new colour.
        { backgroundColor: palette.card, borderColor: palette.sepChat },
      ]}
    >
      <Icon
        name={outcome.kind === "failed" ? "exclamationmark.triangle" : "checkmark"}
        color={outcome.kind === "copy" ? palette.label : palette.sec}
        size={13}
      />
      <Text
        style={[
          typography.footnote,
          { color: outcome.kind === "copy" ? palette.label : palette.sec },
        ]}
      >
        {outcome.label}
      </Text>
      {selectable ? (
        <>
          <Text style={[typography.footnote, { color: palette.sec }]}>·</Text>
          <Pressable
            testID="copy-flash-select"
            accessibilityRole="button"
            accessibilityLabel="Select text"
            onPress={onSelect}
            hitSlop={8}
          >
            <Text style={[typography.footnote, { color: palette.accent }]}>Select text</Text>
          </Pressable>
        </>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    position: "absolute",
    // Above the composer, horizontally centred; `alignSelf` would need a parent
    // row, and this must not affect the transcript's layout at all.
    bottom: size.composer + space.inset + 12,
    alignSelf: "center",
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 14,
    height: 32,
    borderRadius: radius.pill,
    borderWidth: StyleSheet.hairlineWidth,
    ...shadow.glass,
    // iOS only: a pill over a scrolling list must not be clipped by it.
    zIndex: 2,
  },
});
