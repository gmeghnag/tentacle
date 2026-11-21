/**
 * The app's ONE `Text` and `TextInput` (docs/feat/mobile-theme-beta.md): every
 * screen imports them from here, never from `react-native` (pinned by
 * `text-seam.test.ts`), so the app font is decided in one place.
 *
 * A dumb seam: the font comes from `AppFontContext` (set once by `App.tsx` from
 * `themeFor`), the face from `textFont` (`theme-beta.ts`, pure). With the font
 * off (today, the default) it renders React Native's own component with the
 * props it was given — nothing added, no extra element.
 */
import { type ComponentProps, createContext, useContext } from "react";
import { Text as RNText, TextInput as RNTextInput, StyleSheet, type TextStyle } from "react-native";
import { type AppFont, type FontInherit, textFont } from "../theme-beta.ts";

/** The app font in force (`null`: the system font). */
export const AppFontContext = createContext<AppFont>(null);

/** What a Figtree text passes to the texts nested in it (RN inherits font props). */
const InheritContext = createContext<FontInherit>({});

function ownFont(style: ComponentProps<typeof RNText>["style"]) {
  const flat: TextStyle = StyleSheet.flatten(style) ?? {};
  return { fontFamily: flat.fontFamily, fontWeight: flat.fontWeight, fontStyle: flat.fontStyle };
}

export function Text(props: ComponentProps<typeof RNText>) {
  const font = useContext(AppFontContext);
  const inherited = useContext(InheritContext);
  if (font === null) return <RNText {...props} />;
  const { patch, inherit } = textFont(ownFont(props.style), inherited, font);
  return (
    <RNText {...props} style={patch === null ? props.style : [props.style, patch]}>
      <InheritContext.Provider value={inherit}>{props.children}</InheritContext.Provider>
    </RNText>
  );
}

export function TextInput(props: ComponentProps<typeof RNTextInput>) {
  const font = useContext(AppFontContext);
  if (font === null) return <RNTextInput {...props} />;
  const { patch } = textFont(ownFont(props.style), {}, font);
  return <RNTextInput {...props} style={patch === null ? props.style : [props.style, patch]} />;
}
