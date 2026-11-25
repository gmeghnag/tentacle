/**
 * THE ask card (docs/fix/mobile-ask-surfaces.md D4): origin row · title · command
 * box (4 rows, the footer link) · `…  Deny  Allow once`. Drawn from `ask-card.ts`'s
 * view-model; this file owns colours, glyph art and spacing only. The command
 * scrolls inside the card when expanded, the actions sit OUTSIDE the scroll so
 * they stay reachable at any detent. Deny is grey (`fill`/`label`), never red.
 *
 * testIDs: `perm-reject_once`, `perm-allow_once`, `perm-menu`, `perm-<menuId>`,
 * `perm-command-toggle`, `perm-also-asked`, `perm-arming`.
 */
import { type JSX, type ReactNode, useState } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import type { AskCardView, AskMenuItem } from "../ask-card.ts";
import { DENSE_FONT_SCALE, type Palette, radius, typography } from "../theme.ts";
import { Icon } from "./Icon.tsx";
import { PolpettoGlyph } from "./PolpettoGlyph.tsx";
import { Text } from "./Text.tsx";

type Asking = Extract<AskCardView, { kind: "asking" }>;

export interface AskCardProps {
  readonly palette: Palette;
  readonly view: Asking;
  readonly onAnswer: (optionId: "reject_once" | "allow_once") => void;
  readonly onMenu: (id: AskMenuItem["id"]) => void;
  /** Extra rows under the command (the reply field, the auto-accept switch). */
  readonly children?: ReactNode;
}

function OriginGlyph({
  view,
  color,
}: { readonly view: Asking; readonly color: string }): JSX.Element {
  return view.origin.glyph === "polpetto" ? (
    <PolpettoGlyph color={color} size={18} />
  ) : (
    <Icon name={view.origin.glyph} color={color} size={17} />
  );
}

export function AskCard({ palette, view, onAnswer, onMenu, children }: AskCardProps): JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const preview = view.preview;
  const rows = preview === null ? [] : expanded ? preview.expandedRows : preview.shown;
  return (
    <View style={styles.card}>
      <View style={styles.origin}>
        <OriginGlyph view={view} color={palette.sec} />
        <Text numberOfLines={1} style={[typography.footnote, styles.flex, { color: palette.sec }]}>
          <Text style={{ color: palette.label }}>{view.origin.lead}</Text>
          {view.origin.rest === "" ? "" : ` · ${view.origin.rest}`}
        </Text>
        {view.origin.age === null ? null : (
          <Text style={[typography.footnote, { color: palette.sec }]}>{view.origin.age}</Text>
        )}
      </View>
      <Text accessibilityRole="header" style={[typography.title3, { color: palette.label }]}>
        {view.title}
      </Text>
      {preview === null ? null : (
        <View style={[styles.box, { backgroundColor: palette.codeOnSheet }]}>
          <ScrollView style={expanded ? styles.boxScroll : undefined} nestedScrollEnabled>
            {rows.map((row, at) => (
              <Text
                // biome-ignore lint/suspicious/noArrayIndexKey: a row's position is its identity
                key={at}
                style={[typography.monoInline, { color: palette.label }]}
              >
                {row === "" ? " " : row}
              </Text>
            ))}
            {expanded && preview.expandedCut > 0 ? (
              <Text style={[typography.footnote, { color: palette.sec }]}>
                {`… ${preview.expandedCut} more lines not shown`}
              </Text>
            ) : null}
          </ScrollView>
          {preview.more > 0 ? (
            <Pressable testID="perm-command-toggle" onPress={() => setExpanded((on) => !on)}>
              <Text style={[typography.footnote, { color: palette.accent }]}>
                {expanded ? "Show less" : `+${preview.more} lines · Show all`}
              </Text>
            </Pressable>
          ) : null}
        </View>
      )}
      {view.alsoAsked === null ? null : (
        <Text testID="perm-also-asked" style={[typography.footnote, { color: palette.sec }]}>
          {`${view.alsoAsked} · the first answer wins`}
        </Text>
      )}
      {menuOpen && view.menu !== null ? (
        <View style={styles.menu}>
          {view.menu.map((item) => (
            <Pressable
              key={item.id}
              testID={`perm-${item.id}`}
              accessibilityRole="button"
              disabled={!view.armed && item.id !== "auto_accept"}
              onPress={() => {
                setMenuOpen(false);
                onMenu(item.id);
              }}
              style={[styles.menuItem, { backgroundColor: palette.fill }]}
            >
              <Text style={[typography.subhead, { color: palette.label }]}>
                {item.label.replaceAll("`", "")}
              </Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {children}
      {view.armed ? null : (
        <Text testID="perm-arming" style={[typography.footnote, { color: palette.sec }]}>
          Hold on…
        </Text>
      )}
      <View style={styles.actions}>
        {view.menu === null ? (
          <View style={styles.flex} />
        ) : (
          <Pressable
            testID="perm-menu"
            accessibilityRole="button"
            accessibilityLabel="More options"
            onPress={() => setMenuOpen((on) => !on)}
            style={[styles.more, { backgroundColor: palette.fill }]}
          >
            <Icon name="ellipsis" color={palette.label} size={16} />
          </Pressable>
        )}
        {view.actions.map((action) => {
          const allow = action.optionId === "allow_once";
          return (
            <Pressable
              key={action.optionId}
              testID={`perm-${action.optionId}`}
              accessibilityRole="button"
              accessibilityLabel={action.label.replaceAll("`", "")}
              accessibilityState={{ disabled: !view.armed }}
              // The age guard's own decision, read at the tap: `answer` ignores
              // what is too early, and the look says so.
              disabled={!view.armed}
              onPress={() => onAnswer(action.optionId)}
              style={({ pressed }) => [
                styles.capsule,
                { backgroundColor: allow ? palette.accentFill : palette.fill },
                view.armed ? undefined : styles.dimmed,
                pressed ? { opacity: 0.7 } : undefined,
              ]}
            >
              <Text
                maxFontSizeMultiplier={DENSE_FONT_SCALE}
                style={[typography.headline, { color: allow ? palette.onAccent : palette.label }]}
              >
                {action.label.replaceAll("`", "")}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  card: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 32, gap: 12 },
  flex: { flex: 1 },
  origin: { flexDirection: "row", alignItems: "center", gap: 8 },
  box: { borderRadius: radius.tile, padding: 12, gap: 6 },
  boxScroll: { maxHeight: 280 },
  menu: { gap: 8 },
  menuItem: { borderRadius: radius.tile, paddingHorizontal: 14, paddingVertical: 10 },
  actions: { flexDirection: "row", alignItems: "center", gap: 10, justifyContent: "flex-end" },
  more: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: "center",
    justifyContent: "center",
    marginRight: "auto",
  },
  capsule: {
    minHeight: 34,
    borderRadius: 17,
    paddingHorizontal: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  dimmed: { opacity: 0.4 },
});
