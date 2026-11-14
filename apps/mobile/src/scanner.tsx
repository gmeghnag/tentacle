/**
 * The camera, as the ONE native seam (11b.2; the pattern `secure-kv.ts` sets for
 * `expo-secure-store`): this is the only file that imports `expo-camera`, so every
 * other module — and every test in `bun test` — stays free of a native import.
 *
 * It WIRES, it does not decide: the permission state → view-model mapping is
 * `camera-access.ts` (pure, tested), the texts are that module's constants, and
 * this hook only performs the step the view names (`ask` → request, `open` →
 * mount the scanner) and reports what the OS said.
 *
 * What the scanner hands back is the RAW decoded string, which is exactly the
 * line `tentacle pair` prints (`deep-link`'s load-bearing check): the app feeds it
 * to the same intake as a paste, so a scan and a paste cannot diverge.
 */
import { CameraView, type PermissionResponse, useCameraPermissions } from "expo-camera";
import { type JSX, useCallback, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import {
  type CameraView as CameraModel,
  type CameraState,
  cameraStateOf,
  cameraViewFor,
} from "./camera-access.ts";
import type { Palette } from "./theme.ts";

/** What the `Pair` screen needs from the camera (no native type escapes this file). */
export interface PairingCamera {
  /** The pure view-model to render (Scan control, card, copy). */
  readonly view: CameraModel;
  /** Mount the live scanner (only while the person is scanning). */
  readonly scanning: boolean;
  /** The Scan control / denied-card action was tapped. */
  readonly onScan: () => void;
  /** The live preview could not start (a restricted device, a failed session). */
  readonly onMountError: () => void;
  /** One decoded QR string; the screen stops scanning and feeds the intake. */
  readonly onScanned: (text: string) => void;
}

/**
 * The camera's state and actions, for the pairing screen.
 *
 * `denied` is DELIBERATELY not re-requested: iOS resolves a second
 * `requestCameraPermissionsAsync` as `denied` at once, so the tap reveals the
 * card instead (`camera-access.ts` decides that; this hook obeys it).
 */
export function usePairingCamera(onText: (text: string) => void): PairingCamera {
  const [permission, requestPermission] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [tapped, setTapped] = useState(false);
  const [mountFailed, setMountFailed] = useState(false);
  const state: CameraState = cameraStateOf(permission ?? null, mountFailed);
  const view = cameraViewFor(state, tapped);

  const onScan = useCallback(() => {
    setTapped(true);
    switch (view.scan) {
      case "open":
        setScanning(true);
        return;
      case "ask":
        // Decision 10: the ONLY moment the OS prompt appears is this tap.
        void requestPermission().then((answer: PermissionResponse) => {
          if (answer.granted) {
            setScanning(true);
          }
        });
        return;
      // `explain`: the card is now up (Settings is its own button). `none`: no
      // control is drawn, so this cannot be reached.
      case "explain":
      case "none":
        return;
    }
  }, [view.scan, requestPermission]);

  const onScanned = useCallback(
    (text: string) => {
      // First hit wins and scanning stops (a QR stream repeats the same code
      // many times a second, and a second dispatch would re-parse it).
      setScanning(false);
      onText(text);
    },
    [onText],
  );

  return {
    view,
    scanning,
    onScan,
    onMountError: useCallback(() => {
      setMountFailed(true);
      setScanning(false);
    }, []),
    onScanned,
  };
}

/** The live scanner. Mounted only while `scanning`, so the session never outlives the tap. */
export function QrScanner({
  palette,
  onScanned,
  onMountError,
}: {
  readonly palette: Palette;
  readonly onScanned: (text: string) => void;
  readonly onMountError: () => void;
}): JSX.Element {
  return (
    <View style={styles.frame}>
      <CameraView
        testID="pair-camera-view"
        style={styles.camera}
        facing="back"
        // Only QR: a barcode-scanning session that looks for every symbology is
        // slower to lock on, and `tentacle pair` prints a QR and nothing else.
        barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
        onBarcodeScanned={(result) => {
          if (typeof result.data === "string" && result.data !== "") {
            onScanned(result.data);
          }
        }}
        onMountError={onMountError}
      />
      <Text style={[styles.hint, { color: palette.onAccent }]}>
        Point the camera at the QR code `tentacle pair` printed
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { height: 280, justifyContent: "flex-end" },
  camera: { position: "absolute", top: 0, left: 0, right: 0, bottom: 0 },
  hint: { padding: 12, fontSize: 13, textAlign: "center" },
});
