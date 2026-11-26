/**
 * The container-preview wire (docs/feat/container-apps-devices.md): the display
 * update `previews`, the snapshot field, the two methods and three
 * notifications. All additive.
 */
import { describe, expect, test } from "bun:test";
import * as P from "../src/index.ts";

const ROW = {
  id: "0123456789abcdef0123456789abcdef",
  containerId: "f".repeat(64),
  engine: "docker",
  name: "web",
  image: "nginx:latest",
  containerPort: 80,
  createdAt: 1,
};

describe("preview wire", () => {
  test("the `previews` update parses and is a display update, never blocking", () => {
    expect(P.SessionUpdateSchema.safeParse({ type: "previews", previews: [ROW] }).success).toBe(
      true,
    );
    expect(P.SessionUpdateSchema.safeParse({ type: "previews", previews: [] }).success).toBe(true);
    expect(
      P.SessionUpdateSchema.safeParse({ type: "previews", previews: [{ id: "x" }] }).success,
    ).toBe(false);
    expect(P.UPDATE_CLASS.previews).toBe("display");
    expect(P.KNOWN_UPDATE_TYPES).toContain("previews");
    expect(P.BLOCKING_UPDATE_TYPES.has("previews")).toBe(false);
  });

  test("the snapshot carries `previews` (absent = not reported)", () => {
    const base = { messages: [] };
    expect(P.SnapshotResultSchema.parse(base).previews).toBeUndefined();
    expect(P.SnapshotResultSchema.parse({ ...base, previews: [ROW] }).previews).toEqual([ROW]);
  });

  test("the two methods and three notifications are registered", () => {
    expect(P.Method.PreviewConnect).toBe("session/preview_connect");
    expect(P.Method.PreviewStop).toBe("session/preview_stop");
    const connect = P.RequestSchemas[P.Method.PreviewConnect];
    expect(connect.params.safeParse({ sessionId: "s", previewId: ROW.id }).success).toBe(true);
    expect(connect.params.safeParse({ sessionId: "s" }).success).toBe(false);
    expect(connect.result.safeParse({ tunnelId: "t" }).success).toBe(true);
    expect(P.RequestSchemas[P.Method.PreviewStop].result.parse({ ok: true })).toEqual({
      ok: true,
    });
    expect(P.Notification.PreviewData).toBe("preview/data");
    expect(P.Notification.PreviewAck).toBe("preview/ack");
    expect(P.Notification.PreviewClose).toBe("preview/close");
    const ack = P.NotificationSchemas[P.Notification.PreviewAck];
    expect(ack.safeParse({ tunnelId: "t", bytes: 1 }).success).toBe(true);
    expect(ack.safeParse({ tunnelId: "t", bytes: 0 }).success).toBe(false);
    expect(
      P.NotificationSchemas[P.Notification.PreviewData].safeParse({ tunnelId: "t", data: "aGk=" })
        .success,
    ).toBe(true);
    expect(
      P.NotificationSchemas[P.Notification.PreviewClose].safeParse({ tunnelId: "t" }).success,
    ).toBe(true);
  });

  test("the limits and error codes", () => {
    expect(P.MAX_PREVIEWS_PER_SESSION).toBe(8);
    expect(P.MAX_TUNNELS_PER_CONNECTION).toBe(32);
    expect(P.PREVIEW_CHUNK_BYTES).toBe(32 * 1024);
    expect(P.PREVIEW_WINDOW_BYTES).toBe(256 * 1024);
    expect(P.DomainErrorCode.PreviewGone).toBe(-32021);
    expect(P.DomainErrorCode.PreviewUnavailable).toBe(-32022);
    const codes = Object.values(P.DomainErrorCode);
    expect(new Set(codes).size).toBe(codes.length);
  });
});
