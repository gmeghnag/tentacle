/**
 * The sessions drawer (docs/feat/mobile-chrome.md Design 3, mockup C1, slice
 * S6): a 300 pt panel from the left over the session, which is pushed right
 * and dimmed. Top: the computer it lists as its TITLE (tap → the computer
 * menu, when there is more than one), its status line, the magnifier (→ the
 * Sessions screen's search). Then Running / Recent / Archived · n. Bottom:
 * Settings, and the New session pill (S7, `drawer-new-session.ts`).
 *
 * RENDER ONLY (AGENTS §7): what is listed, in which order, what is current,
 * what a failed read says, how it moves — `drawer-list.ts` (`drawerItems`,
 * `drawerTitle`, `drawerComputers`) and `drawer-nav.ts` (`drawerMotion`,
 * `swipeIsHorizontal`, `swipeCloses`). Opened by the hamburger TAP only (F1:
 * the left-edge swipe keeps meaning back); closed by the scrim, a row, a left
 * swipe on the panel or VoiceOver's escape. Every title and meta string is a
 * daemon's (it may be a pod, §7): drawn as plain `Text`, never a link.
 *
 * testIDs: `drawer`, `drawer-scrim`, `drawer-computer`, `drawer-computer-<id>`,
 * `drawer-pair`, `drawer-search`, `drawer-session-<id>` / `drawer-current-<id>`
 * (the open session), `drawer-archived`, `drawer-more`, `drawer-loading`,
 * `drawer-error`, `drawer-retry`, `drawer-stale`, `drawer-empty`,
 * `drawer-settings`, `drawer-row-menu`, `drawer-row-rename`, `drawer-new`,
 * `drawer-new-error`.
 */
import { type JSX, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  ActivityIndicator,
  Animated,
  FlatList,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import type { DrawerComputer, DrawerItem, DrawerRow, DrawerTitle } from "../drawer-list.ts";
import { DRAWER_WIDTH, drawerMotion, swipeCloses, swipeIsHorizontal } from "../drawer-nav.ts";
import type { RenameState } from "../session-rename.ts";
import { DENSE_FONT_SCALE, type Palette } from "../theme.ts";
import { ActionSheet } from "../ui/ActionSheet.tsx";
import { Banner } from "../ui/Banner.tsx";
import { HeaderIcon } from "../ui/HeaderIcon.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PillButton } from "../ui/PillButton.tsx";
import { StatusDot } from "../ui/StatusDot.tsx";
import { RenameSheet } from "./RenameSheet.tsx";

export interface SessionsDrawerProps {
  readonly palette: Palette;
  readonly open: boolean;
  /** `null`: the listed computer is no longer paired — no title is invented. */
  readonly title: DrawerTitle | null;
  readonly menuOpen: boolean;
  readonly computers: readonly DrawerComputer[];
  readonly items: readonly DrawerItem[];
  readonly onClose: () => void;
  readonly onTitle: () => void;
  readonly onPickComputer: (computerId: string) => void;
  readonly onPair: () => void;
  readonly onSearch: () => void;
  readonly onSettings: () => void;
  readonly onOpenRow: (row: DrawerRow) => void;
  readonly onRowMenu: (row: DrawerRow) => void;
  /** The row whose long-press menu is showing. */
  readonly rowMenu: DrawerRow | null;
  readonly onRowMenuClosed: () => void;
  readonly onRename: (row: DrawerRow) => void;
  readonly rename: RenameState | null;
  readonly onRenameText: (text: string) => void;
  readonly onRenameSave: () => void;
  readonly onRenameCancel: () => void;
  /** `shown`: whether the Archived rows are shown now. */
  readonly onToggleArchived: (shown: boolean) => void;
  readonly onMore: () => void;
  readonly onRetry: () => void;
  /** The New session pill (`newSessionPill`, S7): online only, one create at a time. */
  readonly newSession: {
    readonly enabled: boolean;
    readonly busy: boolean;
    readonly error: string | null;
  };
  readonly onNewSession: () => void;
  readonly onNewSessionDismiss: () => void;
  /** The session screen (or its connecting frame). */
  readonly children: ReactNode;
}

/** Reduce Motion, read live (F11): toggling it mid-session converges without a restart. */
function useReduceMotion(): boolean {
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    let live = true;
    void AccessibilityInfo.isReduceMotionEnabled().then((on) => {
      if (live) {
        setReduce(on);
      }
    });
    const subscription = AccessibilityInfo.addEventListener("reduceMotionChanged", setReduce);
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  return reduce;
}

export function SessionsDrawer(props: SessionsDrawerProps): JSX.Element {
  const { palette, open, onClose, children } = props;
  const insets = useSafeAreaInsets();
  const motion = drawerMotion(useReduceMotion());
  const progress = useRef(new Animated.Value(open ? 1 : 0)).current;
  // The panel stays mounted through its closing animation, then leaves the tree
  // (so a closed drawer is nothing to VoiceOver or a flow).
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
    }
    Animated.timing(progress, {
      toValue: open ? 1 : 0,
      duration: motion.duration,
      useNativeDriver: true,
    }).start(({ finished }) => {
      if (finished && !open) {
        setMounted(false);
      }
    });
  }, [open, progress, motion.duration]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_event, g) => swipeIsHorizontal(g.dx, g.dy),
        onPanResponderRelease: (_event, g) => {
          if (swipeCloses(g.dx, g.dy)) {
            closeRef.current();
          }
        },
      }),
    [],
  );
  const pushed = progress.interpolate({ inputRange: [0, 1], outputRange: [0, motion.slide] });
  const panelX = progress.interpolate({ inputRange: [0, 1], outputRange: [-motion.slide, 0] });
  return (
    <View style={styles.root}>
      <Animated.View
        style={[styles.root, { transform: [{ translateX: pushed }] }]}
        accessibilityElementsHidden={open}
        importantForAccessibility={open ? "no-hide-descendants" : "auto"}
      >
        {children}
        {mounted ? (
          <Animated.View
            pointerEvents={open ? "auto" : "none"}
            style={[StyleSheet.absoluteFill, { opacity: progress }]}
          >
            <Pressable
              testID="drawer-scrim"
              accessibilityLabel="Close sessions"
              style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim }]}
              onPress={onClose}
            />
          </Animated.View>
        ) : null}
      </Animated.View>
      {mounted ? (
        <Animated.View
          testID="drawer"
          accessibilityViewIsModal
          onAccessibilityEscape={onClose}
          pointerEvents={open ? "auto" : "none"}
          style={[
            styles.panel,
            {
              backgroundColor: palette.drawer,
              borderRightColor: palette.sepChat,
              paddingTop: insets.top,
              opacity: motion.slide === 0 ? progress : 1,
              transform: [{ translateX: panelX }],
            },
          ]}
          {...pan.panHandlers}
        >
          <Panel {...props} bottom={insets.bottom} />
        </Animated.View>
      ) : null}
    </View>
  );
}

function Panel(props: SessionsDrawerProps & { readonly bottom: number }): JSX.Element {
  const { palette, title, menuOpen, computers, items } = props;
  return (
    <>
      {title === null ? null : (
        <View>
          <View style={styles.titleRow}>
            <Pressable
              testID="drawer-computer"
              accessibilityRole={title.switchable ? "button" : "header"}
              accessibilityLabel={`${title.name}, ${title.status}`}
              accessibilityHint={title.switchable ? "Shows your computers" : undefined}
              disabled={!title.switchable}
              onPress={props.onTitle}
              style={styles.titleButton}
            >
              <Icon name="laptopcomputer" color={palette.label} size={20} weight="light" />
              <Text
                numberOfLines={1}
                maxFontSizeMultiplier={DENSE_FONT_SCALE}
                style={[styles.titleText, { color: palette.label }]}
              >
                {title.name}
              </Text>
              {title.switchable ? (
                <Icon name="chevron.down" color={palette.sec} size={14} weight="light" />
              ) : null}
            </Pressable>
            <HeaderIcon
              palette={palette}
              testID="drawer-search"
              icon="magnifyingglass"
              size={20}
              accessibilityLabel="Search sessions"
              onPress={props.onSearch}
            />
          </View>
          <View style={styles.statusLine}>
            <StatusDot palette={palette} tone={title.tone} size={6} />
            <Text
              numberOfLines={1}
              maxFontSizeMultiplier={DENSE_FONT_SCALE}
              style={[styles.statusText, { color: palette.sec }]}
            >
              {title.project === "" ? title.status : `${title.status} · ${title.project}`}
            </Text>
          </View>
        </View>
      )}
      {menuOpen ? <ComputerMenu {...props} computers={computers} /> : null}
      <FlatList
        style={styles.list}
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => <Item {...props} item={item} />}
      />
      {props.newSession.error === null ? null : (
        <Pressable
          testID="drawer-new-error"
          accessibilityRole="button"
          accessibilityHint="Dismisses this message"
          onPress={props.onNewSessionDismiss}
          style={styles.newError}
        >
          <Text style={[styles.newErrorText, { color: palette.red }]}>
            {props.newSession.error}
          </Text>
        </Pressable>
      )}
      <View
        style={[
          styles.footer,
          { borderTopColor: palette.sepChat, paddingBottom: Math.max(props.bottom, 10) },
        ]}
      >
        <HeaderIcon
          palette={palette}
          testID="drawer-settings"
          icon="gearshape"
          size={21}
          accessibilityLabel="Settings"
          onPress={props.onSettings}
        />
        <View style={styles.footerGap} />
        <PillButton
          palette={palette}
          testID="drawer-new"
          label="New session"
          icon="plus"
          height={40}
          disabled={!props.newSession.enabled}
          busy={props.newSession.busy}
          onPress={props.onNewSession}
        />
      </View>
      <ActionSheet
        palette={palette}
        visible={props.rowMenu !== null}
        testID="drawer-row-menu"
        {...(props.rowMenu === null ? {} : { title: props.rowMenu.title })}
        actions={[
          {
            label: "Rename",
            testID: "drawer-row-rename",
            onPress: () => {
              if (props.rowMenu !== null) {
                props.onRename(props.rowMenu);
              }
            },
          },
        ]}
        onCancel={props.onRowMenuClosed}
      />
      <RenameSheet
        palette={palette}
        state={props.rename}
        onChange={props.onRenameText}
        onSave={props.onRenameSave}
        onCancel={props.onRenameCancel}
      />
    </>
  );
}

function ComputerMenu(props: SessionsDrawerProps): JSX.Element {
  const { palette } = props;
  return (
    <View testID="drawer-computers" style={[styles.menu, { borderColor: palette.sepChat }]}>
      {props.computers.map((computer) => (
        <Pressable
          key={computer.id}
          testID={`drawer-computer-${computer.id}`}
          accessibilityRole="button"
          accessibilityState={{ selected: computer.checked }}
          accessibilityLabel={`${computer.name}, ${computer.status}`}
          onPress={() => props.onPickComputer(computer.id)}
          style={({ pressed }) => [
            styles.menuRow,
            pressed ? { backgroundColor: palette.fill } : null,
          ]}
        >
          <Icon name="laptopcomputer" color={palette.label} size={18} weight="light" />
          <Text numberOfLines={1} style={[styles.menuName, { color: palette.label }]}>
            {computer.name}
          </Text>
          <Text style={[styles.meta, { color: palette.sec }]}>{computer.status}</Text>
          <StatusDot palette={palette} tone={computer.tone} size={7} />
          <View style={styles.check}>
            {computer.checked ? (
              <Icon name="checkmark" color={palette.accent} size={15} weight="regular" />
            ) : null}
          </View>
        </Pressable>
      ))}
      <Pressable
        testID="drawer-pair"
        accessibilityRole="button"
        onPress={props.onPair}
        style={({ pressed }) => [
          styles.menuRow,
          pressed ? { backgroundColor: palette.fill } : null,
        ]}
      >
        <Icon name="plus" color={palette.accent} size={17} weight="light" />
        <Text style={[styles.menuName, { color: palette.accent }]}>Pair a computer</Text>
      </Pressable>
    </View>
  );
}

function Item(props: SessionsDrawerProps & { readonly item: DrawerItem }): JSX.Element {
  const { palette, item } = props;
  switch (item.kind) {
    case "label":
      return <Text style={[styles.section, { color: palette.sec }]}>{item.text}</Text>;
    case "row":
      return <SessionRowView {...props} row={item.row} />;
    case "archived":
      return (
        <Pressable
          testID="drawer-archived"
          accessibilityRole="button"
          accessibilityState={{ expanded: item.open }}
          accessibilityLabel={`Archived, ${item.count}`}
          onPress={() => props.onToggleArchived(item.open)}
          style={({ pressed }) => [styles.row, pressed ? { backgroundColor: palette.fill } : null]}
        >
          <Icon name="archivebox" color={palette.sec} size={19} weight="light" />
          <Text style={[styles.rowTitle, { color: palette.sec }]}>Archived</Text>
          <Text style={[styles.meta, { color: palette.sec }]}>{`${item.count}`}</Text>
          <Icon
            name={item.open ? "chevron.down" : "chevron.right"}
            color={palette.sec}
            size={13}
            weight="light"
          />
        </Pressable>
      );
    case "more":
      return (
        <Pressable
          testID="drawer-more"
          accessibilityRole="button"
          onPress={props.onMore}
          style={styles.row}
        >
          <Text style={[styles.rowTitle, { color: palette.accent }]}>Load more</Text>
        </Pressable>
      );
    case "loading":
      return (
        <View testID="drawer-loading" style={styles.loading}>
          <ActivityIndicator color={palette.accent} />
        </View>
      );
    case "error":
      return (
        <View style={styles.banner}>
          <Banner
            palette={palette}
            tone="error"
            icon="exclamationmark.triangle"
            title="Couldn't load the sessions"
            body={item.text}
            bodyTestID="drawer-error"
            action={{ label: "Retry", onPress: props.onRetry, testID: "drawer-retry" }}
          />
        </View>
      );
    case "stale":
      return (
        <View style={styles.banner}>
          <Banner
            palette={palette}
            testID="drawer-stale"
            tone="warn"
            icon="wifi.slash"
            title="Reconnecting…"
            body={item.text}
          />
        </View>
      );
    case "empty":
      return (
        <Text testID="drawer-empty" style={[styles.empty, { color: palette.sec }]}>
          No sessions yet
        </Text>
      );
  }
}

function SessionRowView(props: SessionsDrawerProps & { readonly row: DrawerRow }): JSX.Element {
  const { palette, row } = props;
  return (
    <Pressable
      testID={row.current ? `drawer-current-${row.id}` : `drawer-session-${row.id}`}
      accessibilityRole="button"
      accessibilityState={{ selected: row.current }}
      accessibilityLabel={row.meta === "" ? row.title : `${row.title}, ${row.meta}`}
      accessibilityHint="Long-press to rename"
      onPress={() => props.onOpenRow(row)}
      onLongPress={() => props.onRowMenu(row)}
      style={({ pressed }) => [
        styles.row,
        row.current || pressed ? { backgroundColor: palette.fill } : null,
      ]}
    >
      <View style={styles.lead}>
        {row.tone === "running" ? (
          <StatusDot palette={palette} tone="running" size={8} />
        ) : (
          <Icon
            name={row.tone === "archived" ? "archivebox" : "bubble.left"}
            color={row.current ? palette.label : palette.sec}
            size={19}
            weight="light"
          />
        )}
      </View>
      <Text
        numberOfLines={1}
        style={[styles.rowTitle, { color: palette.label }, row.current ? styles.current : null]}
      >
        {row.title}
      </Text>
      {row.meta === "" ? null : (
        <Text
          numberOfLines={1}
          maxFontSizeMultiplier={DENSE_FONT_SCALE}
          style={[styles.meta, styles.rowMeta, { color: palette.sec }]}
        >
          {row.meta}
        </Text>
      )}
    </Pressable>
  );
}

// Mockup C1's proportions (`.drawer`, `.dsec`, `.drow`, `.dfoot`).
const styles = StyleSheet.create({
  root: { flex: 1 },
  panel: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    width: DRAWER_WIDTH,
    borderRightWidth: StyleSheet.hairlineWidth,
  },
  titleRow: { flexDirection: "row", alignItems: "center", paddingLeft: 20, paddingRight: 10 },
  titleButton: { flex: 1, minWidth: 0, flexDirection: "row", alignItems: "center", gap: 8 },
  titleText: { flexShrink: 1, fontSize: 17, fontWeight: "600" },
  statusLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingHorizontal: 20,
    paddingBottom: 2,
  },
  statusText: { flexShrink: 1, fontSize: 12 },
  menu: {
    marginTop: 8,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    minHeight: 46,
    paddingHorizontal: 20,
  },
  menuName: { flex: 1, minWidth: 0, fontSize: 15 },
  check: { width: 16, alignItems: "center" },
  list: { flex: 1 },
  section: {
    fontSize: 13,
    lineHeight: 18,
    fontWeight: "500",
    paddingTop: 18,
    paddingBottom: 6,
    paddingHorizontal: 20,
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    minHeight: 44,
    marginHorizontal: 10,
    paddingHorizontal: 10,
    borderRadius: 10,
  },
  lead: { width: 19, alignItems: "center" },
  rowTitle: { flex: 1, minWidth: 0, fontSize: 16, lineHeight: 21 },
  current: { fontWeight: "600" },
  meta: { fontSize: 12 },
  rowMeta: { flexShrink: 0, maxWidth: 110 },
  loading: { paddingVertical: 24 },
  banner: { paddingHorizontal: 10, paddingTop: 12 },
  empty: { fontSize: 15, paddingHorizontal: 20, paddingTop: 18 },
  footer: {
    flexDirection: "row",
    alignItems: "center",
    paddingTop: 6,
    paddingHorizontal: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  footerGap: { flex: 1 },
  newError: { paddingHorizontal: 20, paddingVertical: 8 },
  newErrorText: { fontSize: 13, lineHeight: 18 },
});
