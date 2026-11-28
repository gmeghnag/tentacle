/**
 * The copy half's RENDER (docs/feat/mobile-copy-text.md D2/D3/D4): what the
 * decisions in `message-copy.test.ts` map to on screen — the long-press wrapper
 * and its testID, its absence when the screen offers none, the pill's two
 * states, and the sheet's read-only `TextInput` (never `<Text selectable>`, which
 * on iOS both copies only a whole paragraph and races the row's own long-press).
 *
 * Host stubs are STRING element types (`notice-row.test.ts`'s pattern: a function
 * stub would be called and its result dropped, and every assertion would pass on
 * nothing).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Fragment, isValidElement } from "react";

interface Node {
  readonly type: unknown;
  readonly props: Record<string, unknown>;
  readonly children: Node[];
}

const walk = (element: unknown, out: Node[] = []): Node[] => {
  if (element === null || element === undefined || typeof element === "boolean") return out;
  if (Array.isArray(element)) {
    for (const child of element) walk(child, out);
    return out;
  }
  if (!isValidElement(element)) return out;
  const { type, props } = element as { type: unknown; props: Record<string, unknown> };
  if (type === Fragment) {
    walk(props.children, out);
    return out;
  }
  if (typeof type === "function") {
    walk((type as (p: Record<string, unknown>) => unknown)(props), out);
    return out;
  }
  const node: Node = { type, props, children: [] };
  out.push(node);
  walk(props.children, node.children);
  return out;
};

const all = (nodes: readonly Node[], type: string, out: Node[] = []): Node[] => {
  for (const node of nodes) {
    if (node.type === type) out.push(node);
    all(node.children, type, out);
  }
  return out;
};

/** Every string drawn under `nodes`, in order. */
const texts = (nodes: readonly Node[]): readonly string[] =>
  all(nodes, "Text").flatMap((node) => {
    const child = node.props.children;
    return typeof child === "string" ? [child] : [];
  });

/** Every node in the tree, whatever its type. */
const every = (nodes: readonly Node[], out: Node[] = []): Node[] => {
  for (const node of nodes) {
    out.push(node);
    every(node.children, out);
  }
  return out;
};

/** The nodes carrying `testID`. */
const byTestId = (nodes: readonly Node[], id: string): readonly Node[] =>
  every(nodes).filter((node) => node.props.testID === id);

let transcript: typeof import("../src/screens/transcript/TranscriptRow.tsx");
let theme: typeof import("../src/theme.ts");
let copy: typeof import("../src/message-copy.ts");
let flash: typeof import("../src/ui/CopyFlash.tsx");
let sheet: typeof import("../src/screens/SelectTextSheet.tsx");

beforeAll(async () => {
  const { mock } = await import("bun:test");
  mock.module("react-native", () => ({
    ActivityIndicator: "ActivityIndicator",
    Image: "Image",
    KeyboardAvoidingView: "KeyboardAvoidingView",
    Modal: "Modal",
    Pressable: "Pressable",
    ScrollView: "ScrollView",
    Switch: "Switch",
    Text: "Text",
    View: "View",
    LayoutAnimation: { configureNext: () => {}, create: () => ({}), Types: {}, Properties: {} },
    StyleSheet: { create: (styles: unknown) => styles, hairlineWidth: 0.5 },
    useWindowDimensions: () => ({ fontScale: 1, width: 390, height: 844 }),
    AccessibilityInfo: {
      isReduceMotionEnabled: async () => false,
      addEventListener: () => ({ remove: () => {} }),
    },
    Animated: {
      View: "Animated.View",
      createAnimatedComponent: (c: unknown) => c,
      loop: () => ({ start: () => {}, stop: () => {} }),
      Text: "Animated.Text",
      Value: class {
        interpolate() {
          return this;
        }
        setValue() {}
      },
      timing: () => ({ start: () => {}, stop: () => {} }),
      spring: () => ({ start: () => {}, stop: () => {} }),
      parallel: () => ({ start: () => {}, stop: () => {} }),
    },
    Easing: { bezier: () => (t: number) => t },
    Share: { share: async () => ({}) },
  }));
  // The text seam reads the app font from a context; this walker calls
  // components without React, so it is stubbed to the host strings.
  mock.module("../src/ui/Text.tsx", () => ({ Text: "Text", TextInput: "TextInput" }));
  mock.module("react-native-safe-area-context", () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  }));
  mock.module("expo-symbols", () => ({ SymbolView: "SymbolView" }));
  mock.module("expo", () => ({
    requireNativeView: () => null,
    requireOptionalNativeModule: () => null,
  }));
  mock.module("expo-file-system", () => ({ File: class {}, Paths: { cache: "" } }));
  mock.module("expo-clipboard", () => ({ setStringAsync: async () => true }));
  mock.module("../src/haptics.ts", () => ({ playHaptic: () => {} }));
  mock.module("react-native-svg", () => ({
    default: "Svg",
    Svg: "Svg",
    Circle: "Circle",
    ClipPath: "ClipPath",
    Defs: "Defs",
    G: "G",
    Line: "Line",
    LinearGradient: "LinearGradient",
    Path: "Path",
    Rect: "Rect",
    Stop: "Stop",
    Text: "SvgText",
  }));
  transcript = await import("../src/screens/transcript/TranscriptRow.tsx");
  theme = await import("../src/theme.ts");
  copy = await import("../src/message-copy.ts");
  flash = await import("../src/ui/CopyFlash.tsx");
  sheet = await import("../src/screens/SelectTextSheet.tsx");
});

afterAll(async () => {
  const { mock } = await import("bun:test");
  mock.restore();
});

const NOW = 1_763_700_000_000;
const THUMBS = { loaded: [], inFlight: [], failed: [] };

/**
 * The user row's DRAWN half (`UserRowBody` is exported for exactly this: the
 * stateful `UserRowView` calls hooks, which a walker without a renderer cannot
 * provide).
 */
function drawUserBody(
  onCopy: ((row: unknown, via?: unknown) => void) | null = () => {},
  onCopyRelease?: () => void,
): Node[] {
  return walk(
    transcript.UserRowBody({
      user: userRow as never,
      palette: theme.lightPalette,
      onLink: () => {},
      thumbnails: THUMBS,
      broken: [],
      onOpen: () => {},
      onBroken: () => {},
      ...(onCopy === null ? {} : { onCopy }),
      ...(onCopyRelease === undefined ? {} : { onCopyRelease }),
    }),
  );
}

/** One transcript row as the screen would draw it, with the copy handler (`null` = none). */
function draw(
  row: Record<string, unknown>,
  onCopy: ((row: unknown, via?: unknown) => void) | null = () => {},
  onCopyRelease?: () => void,
): Node[] {
  return walk(
    transcript.TranscriptRow({
      row: row as never,
      palette: theme.lightPalette,
      onLink: () => {},
      thumbnails: THUMBS,
      ...(onCopy === null ? {} : { onCopy }),
      ...(onCopyRelease === undefined ? {} : { onCopyRelease }),
    } as never),
  );
}

/** Every `…-copy` wrapper drawn under `nodes`. */
const copyWrappers = (nodes: readonly Node[]): readonly Node[] =>
  every(nodes).filter((node) => String(node.props.testID).endsWith("-copy"));

const userRow = { kind: "user", key: "u1", text: "hi there", images: [] };
const answerRow = { kind: "assistant", key: "a1", text: "**hello**", version: 9 };
const toolRow = {
  kind: "tool",
  key: "t1",
  id: "c1",
  name: "shell",
  label: "Bash",
  args: "{}",
  status: "ok",
};
const noticeRow = { kind: "notice", key: "n1", text: "a harness line" };
const firedRow = {
  kind: "user",
  key: "w1",
  text: "[scheduled sc-1 · every 10m · fire 5] check CI",
  images: [],
};

describe("R1 the long-press wrapper exists on a MESSAGE row and nowhere else", () => {
  test("a prompt is wrapped, with the row's own testID", () => {
    const wrapper = copyWrappers(drawUserBody());
    expect(wrapper).toHaveLength(1);
    expect(wrapper[0]?.props.testID).toBe("row-u1-copy");
    expect(typeof wrapper[0]?.props.onLongPress).toBe("function");
    // VoiceOver cannot long-press: the same copy is an action on the row.
    expect(wrapper[0]?.props.accessibilityActions).toEqual([
      { name: "copy", label: "Copy message" },
    ]);
  });

  test("an answer is wrapped too, with the row's own testID", () => {
    const wrapper = copyWrappers(draw(answerRow));
    expect(wrapper).toHaveLength(1);
    expect(wrapper[0]?.props.testID).toBe("row-a1-copy");
    expect(typeof wrapper[0]?.props.onLongPress).toBe("function");
    expect(wrapper[0]?.props.accessibilityActions).toEqual([
      { name: "copy", label: "Copy message" },
    ]);
  });

  test("a notice row gets no wrapper (it is not a message)", () => {
    expect(copyWrappers(draw(noticeRow))).toEqual([]);
  });

  test("the wrapper reports the ROW it wraps, as a PRESS", () => {
    const seen: unknown[] = [];
    const nodes = draw(answerRow, (row, via) => seen.push([row, via]));
    const wrapper = copyWrappers(nodes)[0];
    (wrapper?.props.onLongPress as (() => void) | undefined)?.();
    expect(seen).toEqual([[answerRow, "press"]]);
  });

  test("the VoiceOver action copies the same row, as an ACTION (no finger to lift)", () => {
    // An action has no onPressOut: reported as a press, its pill would never count down.
    const seen: unknown[] = [];
    const wrapper = copyWrappers(draw(answerRow, (row, via) => seen.push([row, via])))[0];
    const handler = wrapper?.props.onAccessibilityAction as
      | ((event: { nativeEvent: { actionName: string } }) => void)
      | undefined;
    handler?.({ nativeEvent: { actionName: "copy" } });
    handler?.({ nativeEvent: { actionName: "activate" } });
    expect(seen).toEqual([[answerRow, "action"]]);
  });

  test("the press END is reported, so the pill counts from the release", () => {
    const ended: number[] = [];
    const wrapper = copyWrappers(
      draw(
        answerRow,
        () => {},
        () => ended.push(ended.length + 1),
      ),
    )[0];
    (wrapper?.props.onPressOut as (() => void) | undefined)?.();
    expect(ended).toHaveLength(1);
  });

  test("with no release handler the wrapper still draws, and a release is a no-op", () => {
    const wrapper = copyWrappers(drawUserBody())[0];
    expect(typeof wrapper?.props.onPressOut).toBe("function");
    expect(() => (wrapper?.props.onPressOut as (() => void) | undefined)?.()).not.toThrow();
  });
});

describe("R2 no handler, no wrapper (other callers keep today's rows)", () => {
  test("a prompt and an answer draw exactly as before", () => {
    expect(copyWrappers(drawUserBody(null))).toEqual([]);
    expect(copyWrappers(draw(answerRow, null))).toEqual([]);
  });
});

describe("R3 the pill says what happened", () => {
  test("a copy offers the sheet; the words carry the state, not a colour", () => {
    const nodes = walk(
      flash.CopyFlash({
        outcome: { kind: "copy", text: "hi", label: "Copied" },
        palette: theme.lightPalette,
        onSelect: () => {},
      }),
    );
    expect(texts(nodes)).toEqual(["Copied", "·", "Select text"]);
    expect(byTestId(nodes, "copy-flash")).toHaveLength(1);
    expect(byTestId(nodes, "copy-flash-select")).toHaveLength(1);
  });

  test("nothing to copy: the reason, and NO action to take", () => {
    const nodes = walk(
      flash.CopyFlash({
        outcome: { kind: "empty", label: "No text to copy" },
        palette: theme.lightPalette,
        onSelect: () => {},
      }),
    );
    expect(texts(nodes)).toEqual(["No text to copy"]);
    expect(byTestId(nodes, "copy-flash-select")).toEqual([]);
  });

  test("a refused clipboard never claims Copied", () => {
    const nodes = walk(flash.CopyFlash({ outcome: copy.COPY_FAILED, palette: theme.lightPalette }));
    expect(texts(nodes)).toEqual(["Couldn't copy"]);
    expect(byTestId(nodes, "copy-flash-select")).toEqual([]);
  });
});

describe("R4 the sheet is a read-only TextInput, never a `selectable` Text", () => {
  test("its body is the message's text, editable=false, multiline", () => {
    const nodes = walk(
      sheet.SelectTextSheet({
        palette: theme.lightPalette,
        text: "line one\n\n**markdown**",
        onClose: () => {},
        onCopyAll: () => {},
      }),
    );
    const body = byTestId(nodes, "select-text-body");
    expect(body).toHaveLength(1);
    expect(body[0]?.type).toBe("TextInput");
    expect(body[0]?.props.value).toBe("line one\n\n**markdown**");
    expect(body[0]?.props.editable).toBe(false);
    expect(body[0]?.props.multiline).toBe(true);
    // The read-only flag is what keeps UIKit's selection alive; `disabled` is not
    // it (a disabled view takes no touches, so nothing could be selected).
    expect(body[0]?.props.disabled).toBeUndefined();
    expect(texts(nodes)).toContain("Select text");
    expect(byTestId(nodes, "select-text-copy-all")).toHaveLength(1);
  });

  test("Copy all copies the whole text AND closes the sheet, so the pill is seen", () => {
    // The pill lives on the screen, UNDER this Modal: left open, the sheet would
    // hide both "Copied" and "Couldn't copy" (a silent drop of the failure).
    const calls: string[] = [];
    const nodes = walk(
      sheet.SelectTextSheet({
        palette: theme.lightPalette,
        text: "all of it",
        onClose: () => calls.push("close"),
        onCopyAll: (text) => calls.push(`copy:${text}`),
      }),
    );
    const button = byTestId(nodes, "select-text-copy-all")[0];
    (button?.props.onPress as (() => void) | undefined)?.();
    expect(calls).toEqual(["close", "copy:all of it"]);
  });

  test("a message row draws no `selectable` Text: that is the race the design avoids", () => {
    const selectables = (nodes: readonly Node[]): readonly Node[] =>
      all(nodes, "Text").filter((node) => node.props.selectable === true);
    expect(selectables(drawUserBody())).toEqual([]);
    expect(selectables(draw(answerRow))).toEqual([]);
  });
});
