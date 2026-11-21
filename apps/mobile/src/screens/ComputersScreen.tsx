/**
 * `Computers` — variant A of docs/feat/mobile-projects.md §6 (Owner Q10): per
 * computer its heading (name, status dot + WRITTEN word, "· N of M projects
 * running"), then ONE band with a row per PAIRED project and, last, "Pair a
 * project on this Mac". Only paired projects ever show — no discovery.
 *
 * A dumb renderer (AGENTS §7): sections, rows, words, the menu and every
 * sentence come from `project-rows.ts`; this file maps them to elements.
 *
 * The look is the approved `Main` mockup (docs/feat/mobile-ui-polish.md, Slice 2)
 * restyled to E2 bands by S4 of docs/feat/mobile-chrome.md. The menu and Remove's
 * confirmation are an in-app action sheet, NOT `ActionSheetIOS`/`Alert`: RN's new
 * architecture exposes no native alert text to XCUITest, so every value a flow
 * checks is a testID (plan P9). The testIDs of the one-row-per-computer screen
 * (`computer-<recordId>`, `computer-state-<recordId>-<state>`, `computer-menu-…`,
 * `computer-remove-…`) are kept on the project row, so existing flows still name
 * a record the same way.
 */
import type { JSX } from "react";
import { Pressable, ScrollView, StyleSheet, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import {
  type ProjectRow,
  type ProjectSection,
  projectMenuActions,
  projectSheetMessage,
  removeProjectMessage,
} from "../project-rows.ts";
import { DENSE_FONT_SCALE, type Palette, size as SIZE, space, typography } from "../theme.ts";
import { ActionSheet, type SheetAction } from "../ui/ActionSheet.tsx";
import { BandSection } from "../ui/BandSection.tsx";
import { Banner } from "../ui/Banner.tsx";
import { CompactBar, useCompactTitle } from "../ui/CompactBar.tsx";
import { HeaderIcon } from "../ui/HeaderIcon.tsx";
import { Icon } from "../ui/Icon.tsx";
import { InlineMono } from "../ui/InlineMono.tsx";
import { Row } from "../ui/Row.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { StatusDot } from "../ui/StatusDot.tsx";
import { Text } from "../ui/Text.tsx";

export type { ProjectRow };

export interface ComputersScreenProps {
  readonly palette: Palette;
  readonly sections: readonly ProjectSection[];
  readonly error?: string;
  /** Tap on a project row (the route opens it, or retries one that does not answer). */
  readonly onOpen: (row: ProjectRow) => void;
  /** Pair a computer (the header "+" and the bottom card). */
  readonly onAdd: () => void;
  /** "Pair a project on this Mac" (opens its instructions). */
  readonly onPairProject: (computerId: string) => void;
  /** Whose instructions are showing, if any (a computer id). */
  readonly pairHint?: string;
  readonly onPairHintClosed: () => void;
  /** The instructions' "Scan code". */
  readonly onScan: () => void;
  /** Open a project's sheet (its row's "…", or a long-press on the row). */
  readonly onMenu: (row: ProjectRow) => void;
  readonly menu?: ProjectRow;
  readonly onMenuClosed: () => void;
  /** The sheet's "Try again". */
  readonly onRetry: (row: ProjectRow) => void;
  readonly onRemove: (row: ProjectRow) => void;
  readonly onRemoveConfirmed: (row: ProjectRow) => void;
  readonly onRemoveCancelled: () => void;
  readonly removing?: ProjectRow;
  readonly onPairAgain: (row: ProjectRow) => void;
  readonly onOpenSettings: () => void;
}

export function ComputersScreen(props: ComputersScreenProps): JSX.Element {
  const { palette, sections, error, onAdd, onOpenSettings } = props;
  const insets = useSafeAreaInsets();
  const compact = useCompactTitle();
  return (
    <View style={[styles.root, { backgroundColor: palette.bg }]}>
      <ScrollView
        testID="computers-list"
        style={{ backgroundColor: palette.bg }}
        contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
        onScroll={compact.onScroll}
        scrollEventThrottle={compact.scrollEventThrottle}
      >
        <ScreenHeader
          palette={palette}
          title="Computers"
          right={
            <>
              <HeaderIcon
                testID="open-settings"
                palette={palette}
                icon="slider.horizontal.3"
                accessibilityLabel="Settings"
                onPress={onOpenSettings}
              />
              <HeaderIcon
                testID="computers-add"
                palette={palette}
                icon="plus"
                tone="accent"
                accessibilityLabel="Pair a computer"
                onPress={onAdd}
              />
            </>
          }
        />
        {error === undefined ? null : (
          <View style={styles.section}>
            <Banner
              palette={palette}
              tone="error"
              title="Can’t show your computers"
              body={error}
              bodyTestID="computers-error"
            />
          </View>
        )}
        {sections.map((section) => (
          <ComputerSection key={section.computerId} section={section} {...props} />
        ))}
        <View style={styles.section}>
          <BandSection
            palette={palette}
            footnote={
              <>
                Run{" "}
                <InlineMono palette={palette} size={typography.footnote.fontSize}>
                  tentacle pair
                </InlineMono>{" "}
                in a project’s folder. Only the projects you pair show up here.
              </>
            }
          >
            <Row
              testID="computers-pair-card"
              palette={palette}
              first
              icon="qrcode.viewfinder"
              tone="accent"
              title="Pair a computer"
              titleWeight="600"
              minHeight={SIZE.rowAction}
              onPress={onAdd}
            />
          </BandSection>
        </View>
      </ScrollView>
      <CompactBar palette={palette} title="Computers" shown={compact.shown} />
      <ActionSheet palette={palette} {...sheetOf(props)} />
    </View>
  );
}

function ComputerSection({
  section,
  palette,
  onOpen,
  onMenu,
  onPairProject,
}: ComputersScreenProps & { readonly section: ProjectSection }): JSX.Element {
  const tone = section.state;
  const statusColor =
    tone === "online" ? palette.green : tone === "attention" ? palette.orange : palette.sec;
  return (
    <View style={styles.section} testID={`computer-section-${section.computerId}`}>
      <View style={styles.computerHeader}>
        <Icon name="laptopcomputer" color={palette.label} size={22} />
        <View style={styles.computerText}>
          <Text
            accessibilityRole="header"
            numberOfLines={1}
            maxFontSizeMultiplier={DENSE_FONT_SCALE}
            style={[typography.title3, { color: palette.label }]}
          >
            {section.name}
          </Text>
          <View style={styles.statusLine}>
            <StatusDot
              palette={palette}
              tone={
                tone === "online"
                  ? "online"
                  : tone === "attention"
                    ? "attention"
                    : tone === "checking"
                      ? "wait"
                      : "offline"
              }
              size={7}
            />
            <Text
              testID={`computer-status-${section.computerId}`}
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              style={[typography.footnote, { color: statusColor, fontWeight: "500" }]}
            >
              {section.status}
            </Text>
          </View>
        </View>
      </View>
      <BandSection
        palette={palette}
        {...(section.note === undefined ? {} : { footnote: section.note })}
      >
        {section.rows.map((row, index) => (
          <Row
            key={row.id}
            testID={`computer-${row.id}`}
            palette={palette}
            first={index === 0}
            icon="folder"
            iconDashed={row.muted}
            dimmed={row.muted}
            title={row.label}
            trailing={
              <Pressable
                testID={`computer-menu-${row.id}`}
                accessibilityRole="button"
                accessibilityLabel={`More for ${row.label}`}
                onPress={() => onMenu(row)}
                hitSlop={6}
                style={styles.more}
              >
                <Icon name="ellipsis" color={palette.accent} size={20} />
              </Pressable>
            }
            trailingKind="control"
            chevron
            onPress={() => onOpen(row)}
            onLongPress={() => onMenu(row)}
            accessibilityHint="Opens its sessions. Long-press for more."
          >
            <ProjectStatus palette={palette} row={row} />
          </Row>
        ))}
        <Row
          testID={`computer-pair-project-${section.computerId}`}
          palette={palette}
          first={section.rows.length === 0}
          icon="plus"
          tone="accent"
          title="Pair a project on this Mac"
          minHeight={SIZE.rowAction}
          onPress={() => onPairProject(section.computerId)}
        />
      </BandSection>
    </View>
  );
}

/** The row's sub-line: dot + WRITTEN word (colour-blind rule) + its detail. */
function ProjectStatus({
  palette,
  row,
}: {
  readonly palette: Palette;
  readonly row: ProjectRow;
}): JSX.Element {
  const color =
    row.tone === "on" ? palette.green : row.tone === "attention" ? palette.orange : palette.sec;
  const word = row.justPaired ? "Paired just now" : row.word;
  return (
    <View style={styles.statusLine}>
      {row.justPaired ? (
        <Icon name="checkmark" color={palette.green} size={12} />
      ) : (
        <StatusDot
          palette={palette}
          tone={
            row.tone === "on"
              ? "online"
              : row.tone === "attention"
                ? "attention"
                : row.tone === "wait"
                  ? "wait"
                  : "offline"
          }
          size={7}
        />
      )}
      <Text
        testID={`computer-state-${row.id}-${row.state}`}
        numberOfLines={2}
        style={[typography.footnote, { color: palette.sec, flexShrink: 1 }]}
      >
        <Text style={{ color, fontWeight: "500" }}>{word}</Text>
        {row.detail === "" ? "" : ` · ${row.detail}`}
      </Text>
    </View>
  );
}

/** The one sheet: Remove's confirmation, else a project's menu, else the pair instructions. */
function sheetOf(props: ComputersScreenProps): {
  visible: boolean;
  title?: string;
  message?: string;
  actions: readonly SheetAction[];
  onCancel: () => void;
  testID?: string;
  cancelTestID?: string;
} {
  const { removing, menu, pairHint } = props;
  if (removing !== undefined) {
    return {
      visible: true,
      testID: `computer-remove-confirm-${removing.id}`,
      cancelTestID: `computer-remove-cancel-${removing.id}`,
      title: `Remove “${removing.label}”?`,
      message: removeProjectMessage(removing),
      actions: [
        {
          label: "Remove",
          destructive: true,
          testID: `computer-remove-yes-${removing.id}`,
          onPress: () => props.onRemoveConfirmed(removing),
        },
      ],
      onCancel: props.onRemoveCancelled,
    };
  }
  if (menu !== undefined) {
    return {
      visible: true,
      testID: `computer-menu-sheet-${menu.id}`,
      cancelTestID: `computer-menu-cancel-${menu.id}`,
      title: menu.label,
      message: projectSheetMessage(menu),
      actions: projectMenuActions(menu).map((action) => ({
        label: action.label,
        destructive: action.destructive,
        testID:
          action.kind === "remove"
            ? `computer-remove-${menu.id}`
            : action.kind === "retry"
              ? `computer-retry-${menu.id}`
              : `computer-menu-pair-again-${menu.id}`,
        onPress: () =>
          action.kind === "remove"
            ? props.onRemove(menu)
            : action.kind === "retry"
              ? props.onRetry(menu)
              : props.onPairAgain(menu),
      })),
      onCancel: props.onMenuClosed,
    };
  }
  if (pairHint !== undefined) {
    return {
      visible: true,
      testID: `computer-pair-hint-${pairHint}`,
      title: "Pair a project",
      message: "On the Mac, in the project’s folder, run: tentacle pair",
      actions: [{ label: "Scan code", testID: "computer-pair-hint-scan", onPress: props.onScan }],
      onCancel: props.onPairHintClosed,
    };
  }
  return { visible: false, actions: [], onCancel: props.onMenuClosed };
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  // BandSection owns the section rhythm (`space.sectionTop` above every band), so
  // a computer's block adds none: its heading carries the gap that separates two
  // computers, and the band brings the one under the heading.
  section: { marginTop: 0 },
  computerHeader: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: space.sectionTop,
    paddingLeft: space.inset + 4,
    paddingRight: space.inset - 4,
    paddingBottom: 6,
  },
  computerText: { flex: 1, gap: 2 },
  statusLine: { flexDirection: "row", alignItems: "center", gap: 6 },
  more: {
    width: SIZE.touch,
    height: SIZE.touch,
    alignItems: "center",
    justifyContent: "center",
  },
});
