/**
 * `speech-engine.ts` — the engine preference order and THE never-cloud rule
 * (docs/feat/mobile-voice.md Design §2, F1, F5). Mutation target: dropping the
 * `onDevice` check must fail the F1 test.
 */
import { describe, expect, test } from "bun:test";
import { chooseEngine } from "../src/speech-engine.ts";
import type { AssetStatus, Capabilities } from "../src/speech-native.ts";

const L = "it-IT";
const perms = { mic: "granted", speech: "authorized" } as const;

function caps(
  over: {
    analyzer?: {
      transcriber?: boolean;
      dictation?: boolean;
      asset?: AssetStatus;
      dAsset?: AssetStatus;
    };
    rec?: { supported: boolean; onDevice: boolean };
  } = {},
): Capabilities {
  const a = over.analyzer;
  return {
    os: a === undefined ? 18 : 26,
    ...(a === undefined
      ? {}
      : {
          analyzer: {
            transcriber: a.transcriber ?? true,
            dictation: a.dictation ?? true,
            assets: a.asset === undefined ? {} : { [L]: a.asset },
            ...(a.dAsset === undefined ? {} : { dictationAssets: { [L]: a.dAsset } }),
          },
        }),
    recognizer: over.rec === undefined ? {} : { [L]: over.rec },
    permissions: perms,
  };
}

describe("preference order", () => {
  test("1. transcriber with its model installed", () => {
    expect(chooseEngine(caps({ analyzer: { asset: "installed" } }), L)).toEqual({
      kind: "engine",
      engine: "transcriber",
      locale: L,
    });
  });

  test("2. dictation when the transcriber is not available on this hardware", () => {
    expect(
      chooseEngine(caps({ analyzer: { transcriber: false, asset: "installed" } }), L),
    ).toMatchObject({ kind: "engine", engine: "dictation" });
  });

  test("2. dictation with its own installed model beats a transcriber download", () => {
    expect(
      chooseEngine(caps({ analyzer: { asset: "supported", dAsset: "installed" } }), L),
    ).toMatchObject({ kind: "engine", engine: "dictation" });
  });

  test("3. needsDownload when the model is supported but not installed", () => {
    expect(chooseEngine(caps({ analyzer: { asset: "supported" } }), L)).toEqual({
      kind: "needsDownload",
      engine: "transcriber",
      locale: L,
    });
    expect(chooseEngine(caps({ analyzer: { asset: "downloading" } }), L)).toMatchObject({
      kind: "needsDownload",
    });
  });

  test("4. recognizer on device (iOS 18)", () => {
    expect(chooseEngine(caps({ rec: { supported: true, onDevice: true } }), L)).toEqual({
      kind: "engine",
      engine: "recognizer",
      locale: L,
    });
  });

  test("4. recognizer on device when the iOS 26 asset is unsupported", () => {
    expect(
      chooseEngine(
        caps({ analyzer: { asset: "unsupported" }, rec: { supported: true, onDevice: true } }),
        L,
      ),
    ).toMatchObject({ engine: "recognizer" });
  });

  test("5. nothing → unavailable{locale-unsupported}", () => {
    expect(chooseEngine(caps(), L)).toEqual({
      kind: "unavailable",
      reason: "locale-unsupported",
      locale: L,
    });
  });

  test("5. analyzer without either transcriber and no recognizer → hardware", () => {
    expect(
      chooseEngine(caps({ analyzer: { transcriber: false, dictation: false } }), L),
    ).toMatchObject({ kind: "unavailable", reason: "hardware" });
  });
});

describe("F1: never a network recognizer", () => {
  test("supported && !onDevice is unavailable{no-on-device-model}, never chosen", () => {
    const choice = chooseEngine(caps({ rec: { supported: true, onDevice: false } }), L);
    expect(choice).toEqual({ kind: "unavailable", reason: "no-on-device-model", locale: L });
  });

  test("…also on iOS 26 when no model is usable", () => {
    const choice = chooseEngine(
      caps({ analyzer: { asset: "unsupported" }, rec: { supported: true, onDevice: false } }),
      L,
    );
    expect(choice.kind).toBe("unavailable");
  });
});

describe("F5: reserved-locale cap", () => {
  test("reserve refused → falls back to the on-device recognizer", () => {
    expect(
      chooseEngine(
        caps({ analyzer: { asset: "installed" }, rec: { supported: true, onDevice: true } }),
        L,
        { reserveRefused: true },
      ),
    ).toMatchObject({ engine: "recognizer" });
  });

  test("reserve refused and no on-device recognizer → unavailable", () => {
    expect(
      chooseEngine(caps({ analyzer: { asset: "installed" } }), L, { reserveRefused: true }).kind,
    ).toBe("unavailable");
  });
});
