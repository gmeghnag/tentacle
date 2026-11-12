/**
 * The stop reason is ON the tunnel's wire schema
 * (docs/fix/truncated-reply-silent.md Review HIGH-1).
 *
 * `WireStreamEventSchema` is a STRIP schema (AGENTS §7: "an unknown field is
 * dropped on inbound parse"), so any field it does not name is silently gone by
 * the time the pod's agent reads it. The pod runs the loop and decides from this
 * fact ALONE, so on the schema that lacked it a `length` reply reached `run` /
 * `attach` as a complete answer, and a tool call cut mid-JSON was RUN.
 *
 * RED before the fix: both parses below returned `{"type":"done"}`.
 */
import { describe, expect, test } from "bun:test";
import {
  ModelStreamProgressValueSchema,
  ModelStreamResultSchema,
  PROTOCOL_VERSION,
  WireStreamEventSchema,
} from "../src/index.ts";

const done = (stopReason?: string): Record<string, unknown> => ({
  type: "done",
  ...(stopReason === undefined ? {} : { stopReason }),
});

describe("a tunnelled `done` carries the stop reason", () => {
  test("every reason survives a parse, on both transports", () => {
    for (const reason of ["stop", "length", "tool_calls", "other"] as const) {
      expect(WireStreamEventSchema.parse(done(reason))).toEqual({
        type: "done",
        stopReason: reason,
      });
      // `model/stream`: the collected events of the turn.
      expect(ModelStreamResultSchema.parse({ events: [done(reason)] }).events[0]).toEqual({
        type: "done",
        stopReason: reason,
      });
      // `model/streamChunked`: a `$/progress` batch.
      expect(ModelStreamProgressValueSchema.parse([done(reason)])[0]).toEqual({
        type: "done",
        stopReason: reason,
      });
    }
  });

  test("it stays OPTIONAL: an older laptop's `done` still parses, and no reason is invented", () => {
    // An absent value is `undefined` and the pod's loop then behaves exactly as
    // it did before the fix (the old behaviour), never a failed turn. This is
    // why adding the field needs no `PROTOCOL_VERSION` bump (AGENTS §7).
    expect(WireStreamEventSchema.parse(done())).toEqual({ type: "done" });
    expect(WireStreamEventSchema.parse({ type: "done", usage: undefined })).toEqual({
      type: "done",
    });
  });

  test("no bump: an optional field is free on the wire", () => {
    // 23 is the attachments bump (docs/feat/attachments-core.md), not this field.
    expect(PROTOCOL_VERSION).toBe(23);
  });

  test("a reason outside the enum is refused, never silently coerced", () => {
    // The pod trusts this value to SKIP a tool call, so a bad one must not
    // parse as `undefined` (= today's accept-anything behaviour).
    expect(WireStreamEventSchema.safeParse(done("truncated")).success).toBe(false);
    expect(WireStreamEventSchema.safeParse(done("")).success).toBe(false);
    expect(WireStreamEventSchema.safeParse(done("LENGTH")).success).toBe(false);
  });

  test("usage and the stop reason travel together, and one without the other parses", () => {
    expect(
      WireStreamEventSchema.parse({
        type: "done",
        usage: { promptTokens: 1, completionTokens: 2 },
        stopReason: "length",
      }),
    ).toEqual({
      type: "done",
      usage: { promptTokens: 1, completionTokens: 2 },
      stopReason: "length",
    });
  });
});
