/**
 * `/previews` (docs/feat/session-apps-container-ports.md S4): who may open each
 * row is said in WORDS (never by colour), and the keys.
 */
import { describe, expect, test } from "bun:test";
import type { PreviewRow } from "@tentacle/protocol";
import {
  previewCopyNotice,
  previewStopNotice,
  previewsKey,
  previewsView,
} from "../src/previews-view.ts";

const row = (id: string, link?: PreviewRow["link"]): PreviewRow => ({
  id,
  containerId: "c".repeat(64),
  engine: "podman",
  name: `web-${id}`,
  image: "nginx",
  containerPort: 80,
  createdAt: 0,
  ...(link ? { link } : {}),
});

const secret = row("a", { url: "https://aaaa.apps.example.so/", state: "up", public: false });
const open = row("b", { url: "https://bbbb.apps.example.so/", state: "down", public: true });
const device = row("c");

const texts = (rows: readonly PreviewRow[] | undefined, cursor = 0, width = 100) =>
  previewsView(rows, cursor, width, 20).rows.map((r) => r.text);

describe("previewsView", () => {
  test("each row says who may open it, its state, and its address", () => {
    expect(texts([secret, open, device])).toEqual([
      "▸ secret link · up · web-a port 80",
      "    https://aaaa.apps.example.so/",
      "  PUBLIC · down · web-b port 80",
      "    https://bbbb.apps.example.so/",
      "  paired devices · web-c port 80",
      "    no web link",
    ]);
  });

  test("not reported, and none", () => {
    expect(texts(undefined)).toEqual(["  not reported by this session yet"]);
    expect(texts([])).toEqual(["  No shared containers in this session."]);
  });

  test("fits the width, and names the keys", () => {
    for (const text of texts([secret], 0, 20)) {
      expect(text.length).toBeLessThanOrEqual(20);
    }
    expect(previewsView([secret], 0, 100, 20).hint).toBe(
      "↑↓ select · c copy link · s stop · esc close",
    );
  });
});

describe("previewsKey", () => {
  test("moves, copies, stops, closes", () => {
    expect(previewsKey("c", {})).toBe("copy");
    expect(previewsKey("s", {})).toBe("stop");
    expect(previewsKey("q", {})).toBe("close");
    expect(previewsKey("", { escape: true })).toBe("close");
    expect(previewsKey("", { upArrow: true })).toBe("up");
    expect(previewsKey("", { downArrow: true })).toBe("down");
    expect(previewsKey("x", {})).toBe("none");
  });
});

describe("notices", () => {
  test("a copy says which link it was, never the link", () => {
    expect(previewCopyNotice(secret, undefined)).toBe(
      "_Copied the secret link of web-a. Whoever has it can use the service._",
    );
    expect(previewCopyNotice(open, undefined)).toBe("_Copied the public address of web-b._");
    expect(previewCopyNotice(secret, "no clipboard")).toBe(
      "_The link of web-a was not copied: no clipboard_",
    );
  });

  test("a stop", () => {
    expect(previewStopNotice("web-a", { ok: true })).toBe("_Stopped sharing web-a._");
    expect(previewStopNotice("web-a", { ok: false, reason: "no such preview" })).toBe(
      "_web-a was not stopped: no such preview_",
    );
  });
});
