/**
 * The workflow editor (docs/feat/workflow-editor.md D8, slice 7a): a native-stack
 * PUSH. A dumb renderer (AGENTS §7): the draft, the problems, the Save gate, the
 * review and every refusal are `workflow-edit-controller.ts`'s (D7); the drawing is
 * `workflow-edit-graph.ts`'s (D6); what a tap or a menu row MEANS is
 * `workflow-edit-actions.ts`'s. This file maps those values onto elements and
 * decides nothing — no wire call, no effect, no derivation.
 *
 * Two things are drawn deliberately:
 * - **the file's state in words, on the bar** — the first validator problem
 *   VERBATIM with its YAML path ("same text, word for word"), never cut, and
 *   "Valid · 7 steps" when it is clean. Save is DIM, never hidden.
 * - **glyph AND word on every pill, label and menu row** (the owner is
 *   colour-blind: never meaning by hue alone), and a dangling reference is a
 *   GHOST pill — the break is shown, never hidden.
 *
 * The sheets (kind picker, step, goto, max, settings) are `WorkflowEditSheets.tsx`
 * (7b); Review (`WorkflowEditReview.tsx`) and the New sheet (`WorkflowNew.tsx`) are
 * 7c's, and the route draws them instead of / over this screen.
 */
import { type JSX, useRef } from "react";
import { PanResponder, Pressable, ScrollView, StyleSheet, View } from "react-native";
import Svg, { Path } from "react-native-svg";
import type { Palette } from "../theme.ts";
import { size as SIZE, radius, space, typography } from "../theme.ts";
import { EmptyState } from "../ui/EmptyState.tsx";
import { Icon } from "../ui/Icon.tsx";
import { PillButton } from "../ui/PillButton.tsx";
import { ScreenHeader } from "../ui/ScreenHeader.tsx";
import { Text } from "../ui/Text.tsx";
import {
  type EditIntent,
  type EditMenu,
  barLine,
  draftCaption,
  editMenuModel,
} from "../workflow-edit-actions.ts";
import type { EditState } from "../workflow-edit-controller.ts";
import {
  EDIT_FIX_ELSEWHERE,
  EDIT_OFFLINE,
  EDIT_UPDATE_TENTACLE,
} from "../workflow-edit-controller.ts";
import type {
  EditGeometry,
  EditNode,
  EditPlus,
  EditPort,
  EditTarget,
} from "../workflow-edit-graph.ts";
import { canvasMode } from "../workflow-edit-review.ts";

export interface WorkflowEditScreenProps {
  readonly palette: Palette;
  readonly state: EditState;
  /** `editGeometry` of the draft on screen, made by the route (never here). */
  readonly geometry: EditGeometry | null;
  /** How many steps the file holds (`drawnSteps`): the bar's count, never a ghost. */
  readonly steps: number;
  /**
   * The header's right button (`headerAction`): Save, gated by the controller's
   * own `canSave()`, or Run once a write landed (`canRun()`). Never re-derived here.
   */
  readonly action: { readonly label: "Save" | "Run"; readonly on: boolean };
  /** `savedLine` — "Saved <path> · v<n> · <hash8>" after a write landed, else null. */
  readonly saved: string | null;
  /** A create refused `exists` (`renameOffered`): the file's Rename, else null. */
  readonly onRename: (() => void) | null;
  /** The title: the file's name, or "New workflow" before one is chosen. */
  readonly title: string;
  /** Cancel — the route confirms a dirty draft first (D7's `discardPrompt`). */
  readonly onCancel: () => void;
  /** The right button: Save's `dryRun:true` preview, or Run (the route decides which). */
  readonly onSave: () => void;
  /** `editGraph` — the whole tap → menu → controller path, made by the route. */
  readonly actions: WorkflowEditActions;
  /**
   * The step the long-press menu is open on (`null` = closed). The route fills
   * `dangling` from `deleteStep`'s returned `DraftEdit`, so the note under Delete
   * is what the core just reported, never a second count here (D2).
   */
  readonly menu: {
    readonly id: string;
    readonly dangling: readonly string[];
    readonly index: number;
    readonly count: number;
  } | null;
  readonly onDismissMenu: () => void;
  /** The undo toast's text (`Deleted gate`), or null when nothing was deleted. */
  readonly toast: string | null;
  readonly onUndo: () => void;
  readonly onDismissToast: () => void;
  /** The `broken` screen's "Check again", and `changed`'s Reload. */
  readonly onReload: () => void;
  /** `changed` → Keep editing: the banner goes, the draft stays. */
  readonly onKeepEditing: () => void;
  readonly onOpenSession: () => void;
  /**
   * The title tapped: the workflow's Settings (D8, slice 7b: name, description,
   * inputs, budget). The mockup's entry is "dal titolo", and the title carries no
   * other meaning here — the file's name is not renamed from this screen (D8 has no
   * rename), so the tap has nothing else it could be.
   */
  readonly onSettings: () => void;
}

/** Everything the screen may ask of the draft, and nothing more. */
export interface WorkflowEditActions {
  /** A completed tap: the route's `tapIntent` + `applyIntent`. */
  readonly tap: (target: EditTarget | null) => void;
  /** A `✗` port released, in that port's OWN coordinates: `portRelease` decides. */
  readonly release: (portId: string, locationX: number, locationY: number) => void;
  /** A long press on a step: the menu opens on it. */
  readonly longPress: (id: string) => void;
  /** A menu row: `editMenuModel`'s own intent. */
  readonly menu: (intent: EditIntent) => void;
  /** The `✗` port this canvas has armed (`null` = none). */
  readonly armed: string | null;
  /** The steps a held `✗` port may be dropped on (`validDropTargets`), dimmed when not. */
  readonly dropTargets: readonly string[];
}

/** One pill: a real step, or a ghost for a reference that names no step. */
function Pill({
  palette,
  node,
  onTap,
  onLongPress,
  dimmed,
  target,
}: {
  readonly palette: Palette;
  readonly node: EditNode;
  readonly onTap: () => void;
  readonly onLongPress: () => void;
  /** A `✗` port is held and this pill is not a legal target (D6's view-model flag). */
  readonly dimmed: boolean;
  /** A `✗` port is held and this pill IS a legal target: it is ticked. */
  readonly target: boolean;
}): JSX.Element {
  return (
    <Pressable
      testID={`workflow-edit-node-${node.id}`}
      accessibilityRole="button"
      accessibilityLabel={`${node.id} · ${node.sub}${node.ghost ? " · no such step" : ""}`}
      onPress={onTap}
      onLongPress={node.ghost ? undefined : onLongPress}
      delayLongPress={400}
      style={[
        styles.pill,
        dimmed ? styles.dim : null,
        {
          left: node.x,
          top: node.y,
          width: node.width,
          height: node.height,
          borderRadius: node.radius,
          backgroundColor: palette.card,
          borderColor: target ? palette.accent : node.bad ? palette.orange : palette.sep,
          borderStyle: node.ghost ? "dashed" : "solid",
        },
      ]}
    >
      <Text style={[styles.glyph, { color: palette.label }]}>{node.glyph}</Text>
      <View style={styles.pillText}>
        <Text style={[styles.pillName, { color: palette.label }]} numberOfLines={1}>
          {node.ghost ? `${node.id} ?` : node.id}
        </Text>
        <Text style={[styles.pillSub, { color: palette.sec }]} numberOfLines={1}>
          {node.bad && !node.ghost ? `⚠ ${node.sub}` : node.sub}
        </Text>
      </View>
    </Pressable>
  );
}

/** The `＋` on an edge (or at the end): it inserts where the geometry says. */
function Plus({
  palette,
  plus,
  onTap,
}: {
  readonly palette: Palette;
  readonly plus: EditPlus;
  readonly onTap: () => void;
}): JSX.Element {
  return (
    <Pressable
      testID={`workflow-edit-plus-${"after" in plus.insertAt ? plus.insertAt.after : "end"}`}
      accessibilityRole="button"
      accessibilityLabel="Insert a step here"
      onPress={onTap}
      style={[
        styles.plus,
        {
          left: plus.hit.x,
          top: plus.hit.y,
          width: plus.hit.w,
          height: plus.hit.h,
        },
      ]}
    >
      <View style={[styles.plusDot, { backgroundColor: palette.card, borderColor: palette.sep }]}>
        <Text style={[styles.plusGlyph, { color: palette.accent }]}>＋</Text>
      </View>
    </Pressable>
  );
}

/** The `✗` port: tap it (then a step), or drag it onto one — ONE release handler. */
function Port({
  palette,
  port,
  armed,
  onDrop,
}: {
  readonly palette: Palette;
  readonly port: EditPort;
  readonly armed: boolean;
  /** Where the finger LIFTS, in this port's own coordinates: `portRelease` adds its offset. */
  readonly onDrop: (locationX: number, locationY: number) => void;
}): JSX.Element {
  // The latest `onDrop` (a fresh closure each render) behind ONE responder: a
  // responder rebuilt mid-gesture would lose the touch it holds.
  const drop = useRef(onDrop);
  drop.current = onDrop;
  const grant = useRef({ x: 0, y: 0 });
  const responder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: () => true,
      // Held until the finger lifts: the canvas's scroll view cannot take the drag.
      onPanResponderTerminationRequest: () => false,
      onPanResponderGrant: (event) => {
        grant.current = { x: event.nativeEvent.locationX, y: event.nativeEvent.locationY };
      },
      // The lift point = where the touch began inside the port + how far it moved.
      onPanResponderRelease: (_event, gesture) =>
        drop.current(grant.current.x + gesture.dx, grant.current.y + gesture.dy),
    }),
  ).current;
  return (
    <View
      {...responder.panHandlers}
      testID={`workflow-edit-port-${port.id}`}
      accessible
      accessibilityRole="button"
      accessibilityState={{ selected: armed }}
      accessibilityLabel={
        armed ? `${port.id} fail port, armed: tap the step it goes to` : `${port.id} fail port`
      }
      style={[
        styles.port,
        {
          left: port.hit.x,
          top: port.hit.y,
          width: port.hit.w,
          height: port.hit.h,
        },
      ]}
    >
      <View
        style={[
          styles.portDot,
          {
            backgroundColor: armed ? palette.accentFill : palette.card,
            borderColor: armed ? palette.accentFill : palette.sep,
          },
        ]}
      >
        <Text style={[styles.portGlyph, { color: armed ? palette.onAccent : palette.sec }]}>✗</Text>
      </View>
    </View>
  );
}

/** The canvas: the edges, the pills, the `＋` anchors, the ports, the labels. */
function Canvas({
  palette,
  geometry,
  armed,
  dropTargets,
  actions,
}: {
  readonly palette: Palette;
  readonly geometry: EditGeometry;
  readonly armed: string | null;
  readonly dropTargets: readonly string[];
  readonly actions: WorkflowEditActions;
}): JSX.Element {
  return (
    <View testID="workflow-edit-canvas" style={{ width: geometry.width, height: geometry.height }}>
      <Svg width={geometry.width} height={geometry.height} style={StyleSheet.absoluteFill}>
        {geometry.edges.map((edge) => (
          <Path
            key={edge.key}
            d={edge.d}
            stroke={edge.bad ? palette.orange : edge.kind === "fail" ? palette.sec : palette.sec}
            strokeWidth={edge.bad ? 2 : 1.5}
            strokeDasharray={edge.kind === "fail" ? "4 4" : undefined}
            fill="none"
          />
        ))}
      </Svg>
      {/* The canvas itself: a tap on the ground puts an armed port down. Drawn
          FIRST, so it lies under every pill, ＋, ✗ and label (a later sibling is
          on top in React Native, and would take their touches). */}
      <Pressable
        testID="workflow-edit-ground"
        accessibilityLabel="Canvas"
        style={StyleSheet.absoluteFill}
        onPress={() => actions.tap(null)}
      />
      {geometry.nodes.map((node) => (
        <Pill
          key={`n-${node.id}`}
          palette={palette}
          node={node}
          onTap={() => actions.tap({ kind: "node", id: node.id })}
          onLongPress={() => actions.longPress(node.id)}
          dimmed={armed !== null && !dropTargets.includes(node.id)}
          target={armed !== null && dropTargets.includes(node.id)}
        />
      ))}
      {geometry.pluses.map((plus) => (
        <Plus
          key={`p-${"after" in plus.insertAt ? plus.insertAt.after : "end"}`}
          palette={palette}
          plus={plus}
          onTap={() => actions.tap({ kind: "plus", insertAt: plus.insertAt })}
        />
      ))}
      {geometry.ports.map((port) => (
        <Port
          key={`port-${port.id}`}
          palette={palette}
          port={port}
          armed={armed === port.id}
          onDrop={(locationX, locationY) => actions.release(port.id, locationX, locationY)}
        />
      ))}
      {geometry.labels.map((label) => (
        <Pressable
          key={`l-${label.id}-${label.which}`}
          testID={`workflow-edit-label-${label.id}-${label.which}`}
          accessibilityRole="button"
          accessibilityLabel={`${label.id} · ${label.text}`}
          onPress={() => actions.tap({ kind: "label", id: label.id, which: label.which })}
          style={[
            styles.label,
            {
              left: label.hit.x,
              top: label.hit.y,
              width: label.hit.w,
              height: label.hit.h,
            },
          ]}
        >
          <Text style={[styles.labelText, { color: palette.label }]}>{label.text}</Text>
        </Pressable>
      ))}
    </View>
  );
}

/** The long-press menu: the model's rows, the note under Delete, and a scrim. */
function Menu({
  palette,
  menu,
  onPick,
  onDismiss,
}: {
  readonly palette: Palette;
  readonly menu: EditMenu;
  readonly onPick: (intent: EditIntent) => void;
  readonly onDismiss: () => void;
}): JSX.Element {
  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable
        accessibilityLabel="Dismiss"
        style={[StyleSheet.absoluteFill, { backgroundColor: palette.scrim }]}
        onPress={onDismiss}
      />
      <View testID="workflow-edit-menu" style={[styles.menu, { backgroundColor: palette.sheet }]}>
        {menu.items.map((item) => (
          <Pressable
            key={item.label}
            testID={`workflow-edit-menu-${item.label.toLowerCase().replace(/ /g, "-")}`}
            accessibilityRole="button"
            accessibilityState={{ disabled: item.off }}
            disabled={item.off}
            onPress={() => onPick(item.intent as EditIntent)}
            style={[styles.menuRow, { borderTopColor: palette.sepSheet }]}
          >
            <Text
              style={[
                styles.menuLabel,
                { color: item.destructive === true ? palette.red : palette.label },
                item.off ? styles.dim : null,
              ]}
            >
              {item.label}
            </Text>
            <Text style={[styles.menuGlyph, { color: palette.sec }, item.off ? styles.dim : null]}>
              {item.glyph}
            </Text>
          </Pressable>
        ))}
        {menu.note === null ? null : (
          <Text style={[styles.menuNote, { color: palette.sec }]}>{menu.note}</Text>
        )}
      </View>
    </View>
  );
}

/** Why there is no editor at all: the daemon's own words, then one line of advice. */
function NoEditor({
  testID,
  palette,
  title,
  body,
  lines,
  advice,
  action,
}: {
  readonly testID: string;
  readonly palette: Palette;
  readonly title: string;
  readonly body?: string | undefined;
  readonly lines?: readonly string[];
  readonly advice?: string | undefined;
  readonly action?: JSX.Element;
}): JSX.Element {
  return (
    <View style={styles.noEditor}>
      <EmptyState
        testID={testID}
        palette={palette}
        title={title}
        body={body}
        icon="exclamationmark.triangle"
        {...(action === undefined ? {} : { action })}
      />
      {lines === undefined
        ? null
        : lines.map((line) => (
            <Text key={line} style={[typography.mono, { color: palette.label }]}>
              {line}
            </Text>
          ))}
      {advice === undefined ? null : (
        <Text style={[typography.footnote, { color: palette.sec }]}>{advice}</Text>
      )}
    </View>
  );
}

export function WorkflowEditScreen(props: WorkflowEditScreenProps): JSX.Element {
  const { palette, state, geometry } = props;
  // `edit` | `view` (saved: drawn, not touchable) | null — the module's answer.
  const mode = canvasMode(state.kind);
  const editable = geometry !== null && mode !== null;
  const menu = props.menu;
  return (
    <View testID="workflow-edit" style={[styles.screen, { backgroundColor: palette.page }]}>
      <ScreenHeader
        palette={palette}
        variant="compact"
        title={props.title}
        subtitle={draftCaption({
          phase: state.kind,
          savedVersion: state.saved?.version ?? null,
        })}
        titleTestID="workflow-edit-title"
        onTitlePress={props.onSettings}
        titlePressLabel="Settings"
        titlePressHint="Opens the workflow's name, description, inputs and budget"
        left={
          <Pressable
            testID="workflow-edit-cancel"
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            hitSlop={8}
            onPress={props.onCancel}
          >
            <Text style={[typography.body, { color: palette.accent }]}>Cancel</Text>
          </Pressable>
        }
        right={
          <Pressable
            testID="workflow-edit-save"
            accessibilityRole="button"
            accessibilityLabel={props.action.label}
            accessibilityState={{ disabled: !props.action.on }}
            disabled={!props.action.on}
            hitSlop={8}
            onPress={props.onSave}
          >
            <Text
              style={[
                typography.body,
                { color: props.action.on ? palette.accent : palette.sec, fontWeight: "600" },
              ]}
            >
              {props.action.label}
            </Text>
          </Pressable>
        }
      />
      {state.notice === null ? null : (
        <Text testID="workflow-edit-notice" style={[styles.notice, { color: palette.sec }]}>
          {state.notice}
        </Text>
      )}
      {props.onRename === null ? null : (
        <View style={styles.changedRow}>
          <PillButton
            palette={palette}
            testID="workflow-edit-rename"
            kind="secondary"
            label="Rename"
            onPress={props.onRename}
          />
        </View>
      )}
      {/* "Changed on the computer": the draft is KEPT, and neither reloading nor
          editing is assumed — the person chooses (D7). */}
      {state.changed ? (
        <View testID="workflow-edit-changed" style={styles.changed}>
          <Text style={[typography.subhead, { color: palette.label }]}>
            Changed on the computer
          </Text>
          <View style={styles.changedRow}>
            <PillButton
              palette={palette}
              testID="workflow-edit-changed-reload"
              kind="secondary"
              label="Reload"
              onPress={props.onReload}
            />
            <PillButton
              palette={palette}
              testID="workflow-edit-changed-keep"
              kind="neutral"
              label="Keep editing"
              onPress={props.onKeepEditing}
            />
          </View>
        </View>
      ) : null}
      {geometry === null ? null : editable ? (
        <ScrollView contentContainerStyle={styles.content}>
          {/* Saved: the graph stays drawn under Run and still scrolls, but its
              pills take no touch (the controller edits nothing in `saved`). */}
          <View
            testID="workflow-edit-canvas-wrap"
            pointerEvents={mode === "view" ? "none" : "auto"}
          >
            <Canvas
              palette={palette}
              geometry={geometry}
              armed={props.actions.armed}
              dropTargets={props.actions.dropTargets}
              actions={props.actions}
            />
          </View>
        </ScrollView>
      ) : null}
      {state.kind === "loading" || state.kind === "opening" ? (
        <EmptyState palette={palette} loading />
      ) : null}
      {state.kind === "broken" ? (
        <NoEditor
          testID="workflow-edit-broken"
          palette={palette}
          title="This file does not validate"
          lines={state.errors}
          advice={EDIT_FIX_ELSEWHERE}
          action={
            <PillButton
              palette={palette}
              kind="secondary"
              label="Check again"
              onPress={props.onReload}
            />
          }
        />
      ) : null}
      {state.kind === "unreadable" ? (
        <NoEditor
          testID="workflow-edit-unreadable"
          palette={palette}
          title="This file cannot be opened as a workflow"
          body={state.reason ?? undefined}
          advice={EDIT_FIX_ELSEWHERE}
        />
      ) : null}
      {state.kind === "unsupported" ? (
        <NoEditor
          testID="workflow-edit-unsupported"
          palette={palette}
          title={EDIT_UPDATE_TENTACLE}
          advice="Editing a workflow needs a newer tentacle on the computer"
        />
      ) : null}
      {state.kind === "unavailable" ? (
        <NoEditor
          testID="workflow-edit-unavailable"
          palette={palette}
          title="This session cannot edit workflows"
          body={state.reason ?? undefined}
        />
      ) : null}
      {state.kind === "ended" || state.kind === "failed" ? (
        <NoEditor
          testID="workflow-edit-failed"
          palette={palette}
          title="Could not open the editor"
          body={state.reason ?? undefined}
          action={
            <PillButton
              palette={palette}
              kind="secondary"
              label="Back to the session"
              onPress={props.onOpenSession}
            />
          }
        />
      ) : null}
      {/* The bottom bar: the file's state in words, in the thumb zone (D8). */}
      {state.draft === null ? null : (
        <View
          testID="workflow-edit-bar"
          style={[styles.bar, { backgroundColor: palette.band, borderTopColor: palette.sep }]}
        >
          <Text
            testID="workflow-edit-bar-text"
            style={[
              typography.footnote,
              styles.barText,
              { color: state.saveOff === null ? palette.green : palette.label },
            ]}
          >
            {barLine({ saveOff: state.saveOff, steps: props.steps })}
          </Text>
        </View>
      )}
      {state.offline ? (
        <Text testID="workflow-edit-offline" style={[styles.barText, { color: palette.sec }]}>
          {EDIT_OFFLINE}
        </Text>
      ) : null}
      {menu === null ? null : (
        <Menu
          palette={palette}
          menu={editMenuModel({
            id: menu.id,
            dangling: menu.dangling,
            index: menu.index,
            count: menu.count,
          })}
          onPick={(intent) => props.actions.menu(intent)}
          onDismiss={props.onDismissMenu}
        />
      )}
      {/* The saved toast: no Undo (a write is not undone from here; git keeps the old text). */}
      {props.saved === null ? null : (
        <View
          testID="workflow-edit-saved"
          style={[styles.toast, { backgroundColor: palette.glass }]}
        >
          <Text style={[typography.footnote, { color: palette.label }]}>{props.saved}</Text>
        </View>
      )}
      {props.toast === null ? null : (
        <View
          testID="workflow-edit-toast"
          style={[styles.toast, { backgroundColor: palette.glass }]}
        >
          <Text style={[typography.footnote, { color: palette.label }]}>{props.toast}</Text>
          <Pressable testID="workflow-edit-undo" accessibilityRole="button" onPress={props.onUndo}>
            <Text style={[typography.footnote, { color: palette.accent }]}>Undo</Text>
          </Pressable>
          <Pressable
            testID="workflow-edit-toast-dismiss"
            accessibilityLabel="Dismiss"
            hitSlop={8}
            onPress={props.onDismissToast}
          >
            <Icon name="xmark" color={palette.sec} size={12} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1 },
  content: { padding: space.inset, alignItems: "center" },
  notice: { ...typography.footnote, paddingHorizontal: space.inset, paddingBottom: 6 },
  changed: { gap: 8, paddingHorizontal: space.inset, paddingBottom: 8 },
  changedRow: { flexDirection: "row", gap: 8 },
  bar: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: SIZE.rowAction,
    paddingHorizontal: space.inset,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  barText: { ...typography.footnote, paddingHorizontal: space.inset },
  noEditor: { gap: 8, paddingHorizontal: space.inset },
  pill: {
    position: "absolute",
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 10,
    borderWidth: StyleSheet.hairlineWidth,
  },
  pillText: { flex: 1 },
  glyph: { ...typography.footnote, width: 20, textAlign: "center" },
  pillName: { ...typography.step, fontWeight: "600" },
  pillSub: { ...typography.caption },
  plus: { position: "absolute", alignItems: "center", justifyContent: "center" },
  plusDot: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  plusGlyph: { ...typography.caption, lineHeight: 14 },
  port: { position: "absolute", alignItems: "center", justifyContent: "center" },
  portDot: {
    width: 16,
    height: 16,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    alignItems: "center",
    justifyContent: "center",
  },
  portGlyph: { fontSize: 9, lineHeight: 11 },
  label: { position: "absolute", alignItems: "center", justifyContent: "center" },
  labelText: { ...typography.mono, fontSize: 12 },
  menu: {
    position: "absolute",
    borderRadius: radius.dialog,
    overflow: "hidden",
    alignSelf: "center",
    width: "62%",
  },
  menuRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    minHeight: SIZE.rowSetting,
    paddingHorizontal: 16,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  menuLabel: { ...typography.body },
  menuGlyph: { ...typography.body },
  menuNote: { ...typography.caption, paddingHorizontal: 16, paddingBottom: 10 },
  dim: { opacity: 0.4 },
  toast: {
    position: "absolute",
    left: space.inset,
    right: space.inset,
    bottom: SIZE.rowAction + space.inset,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderRadius: radius.tile,
    paddingHorizontal: 14,
    minHeight: 44,
    gap: 12,
  },
});
