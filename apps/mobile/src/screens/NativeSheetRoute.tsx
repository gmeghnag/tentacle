/**
 * One native sheet (docs/feat/mobile-native-sheets.md D1/D2): the stack ROUTE
 * that a `<Modal>` used to be. It draws nothing of its own — it reads what the
 * session screen published on `SHEET_HOSTS` for its kind and renders it, and the
 * ONE branch it takes (draw / wait / pop) is `sheetRouteView`'s, in the pure
 * module (AGENTS §7: this file maps a view-model to elements).
 *
 * Why the content comes through a registry and not through params: the sheet's
 * state and callbacks live in `SessionScreen`, which stays mounted under this
 * route (NS renders every route and freezes nothing). Params would have to carry
 * a React element, and `contentStyle` — the ground (`sheet-plan`'s
 * `sheetGround`, set by App.tsx's screen options) — already paints behind it.
 */
import { type JSX, type ReactNode, useEffect, useMemo, useSyncExternalStore } from "react";
import { StyleSheet, View } from "react-native";
import { SHEET_HOSTS, sheetRouteView } from "../sheet-host.ts";
import type { SheetKind } from "../sheet-plan.ts";

export interface NativeSheetRouteProps {
  readonly computerId: string;
  readonly sessionId: string;
  readonly kind: SheetKind;
  /** The keyed `pop` of THIS route's own key (never `goBack()`). */
  readonly onClose: () => void;
}

export function NativeSheetRoute(props: NativeSheetRouteProps): JSX.Element | null {
  const { computerId, sessionId, kind, onClose } = props;
  const host = useMemo(() => SHEET_HOSTS.host(computerId, sessionId), [computerId, sessionId]);
  const snapshot = useSyncExternalStore(host.subscribe, () => host.snapshot(kind));
  const view = sheetRouteView(snapshot);
  useEffect(() => {
    if (view === "pop") {
      onClose();
    }
  }, [view, onClose]);
  // An empty sheet is never drawn (owner rule): `wait` is a route that is up
  // before its screen's first publish, and `pop` is the same pass that closes it.
  if (view !== "draw") {
    return null;
  }
  return (
    <View testID={`native-sheet-${kind}`} style={styles.fill}>
      {snapshot.content as ReactNode}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
