import { describe, expect, test } from "bun:test";
import {
  ChatMessageSchema,
  MAX_PERMISSION_REPLY_CHARS,
  PermissionReplyTextSchema,
  PermissionRequestUpdateSchema,
  ResolvePermissionParamsSchema,
  SessionUpdateSchema,
  SnapshotResultSchema,
  ToolCallUpdateSchema,
  UPDATE_CLASS,
} from "../src/index.ts";

// docs/feat/permission-reply.md: "No, let's talk about it" — the request says
// it takes a reply, the answer carries it, the refused call shows it.
const resolve = (message: unknown) => ({
  sessionId: "s",
  requestId: "r",
  optionId: "reject_once",
  message,
});
const request = {
  type: "permission_request",
  requestId: "r",
  toolCallId: "c",
  tool: "shell",
  title: "Run a shell command",
  options: [{ optionId: "reject_once", name: "Deny", kind: "reject_once" }],
};

describe("the reply text", () => {
  test("bounds: 1..MAX chars, \\n and \\t only, not whitespace-only", () => {
    expect(MAX_PERMISSION_REPLY_CHARS).toBe(2000);
    const ok = (s: string): boolean => PermissionReplyTextSchema.safeParse(s).success;
    expect(ok("x".repeat(2000))).toBe(true);
    expect(ok("x".repeat(2001))).toBe(false);
    expect(ok("why?\n\ttry bun run build")).toBe(true);
    expect(ok("a\u001b[2Jb")).toBe(false);
    expect(ok("a\rb")).toBe(false);
    expect(ok("a\u0085b")).toBe(false);
    expect(ok("a\u007fb")).toBe(false);
    expect(ok("  \n\t ")).toBe(false);
    expect(ok("")).toBe(false);
  });

  test("on session/resolve_permission: kept when valid, refuses the frame otherwise", () => {
    const parsed = ResolvePermissionParamsSchema.safeParse(resolve("try bun run build"));
    expect(parsed.success ? parsed.data.message : undefined).toBe("try bun run build");
    expect(ResolvePermissionParamsSchema.safeParse(resolve("  ")).success).toBe(false);
    expect(ResolvePermissionParamsSchema.safeParse(resolve("x".repeat(2001))).success).toBe(false);
    const { message: _m, ...plain } = resolve("x");
    expect(ResolvePermissionParamsSchema.safeParse(plain).success).toBe(true);
  });
});

describe("permission_request.reply", () => {
  test("kept by a new client; maxChars a positive integer", () => {
    const parsed = PermissionRequestUpdateSchema.safeParse({
      ...request,
      reply: { maxChars: 2000 },
    });
    expect(parsed.success ? parsed.data.reply : undefined).toEqual({ maxChars: 2000 });
    for (const maxChars of [0, 1.5, -1, "2000"]) {
      expect(
        PermissionRequestUpdateSchema.safeParse({ ...request, reply: { maxChars } }).success,
      ).toBe(false);
    }
  });

  test("an older client strips it and still parses the blocking request", () => {
    const older = PermissionRequestUpdateSchema.omit({ reply: true });
    const parsed = older.safeParse({ ...request, reply: { maxChars: 2000 } });
    expect(parsed.success && !("reply" in parsed.data)).toBe(true);
    expect(UPDATE_CLASS.permission_request).toBe("blocking");
  });

  test("an older daemon strips a message (why a client sends one only when offered)", () => {
    const older = ResolvePermissionParamsSchema.omit({ message: true });
    const parsed = older.safeParse(resolve("why?"));
    expect(parsed.success && !("message" in parsed.data)).toBe(true);
  });
});

describe("denialReply on the refused call", () => {
  const update = (r: unknown) => ({
    type: "tool_call_update",
    toolCallId: "c",
    status: "failed",
    content: [{ type: "text", text: "Permission denied" }],
    denialReply: r,
  });
  const message = (r: unknown) => ({ role: "tool", content: "x", toolCallId: "c", denialReply: r });

  test("kept on tool_call_update, a ChatMessage and a snapshot page", () => {
    const u = SessionUpdateSchema.safeParse(update("try bun run build"));
    expect(u.success && u.data.type === "tool_call_update" ? u.data.denialReply : undefined).toBe(
      "try bun run build",
    );
    const m = ChatMessageSchema.safeParse(message("why?"));
    expect(m.success ? m.data.denialReply : undefined).toBe("why?");
    const snap = SnapshotResultSchema.safeParse({ messages: [message("why?")] });
    expect(snap.success ? snap.data.messages[0]?.denialReply : undefined).toBe("why?");
  });

  test("the same bounds as the answer (a pod's value never reaches the terminal raw)", () => {
    for (const r of ["", "  ", "a\u001bb", "x".repeat(2001), 3]) {
      expect(ToolCallUpdateSchema.safeParse(update(r)).success).toBe(false);
      expect(ChatMessageSchema.safeParse(message(r)).success).toBe(false);
    }
  });

  test("an older peer drops it and keeps the content; the carrier stays display", () => {
    const olderUpdate = ToolCallUpdateSchema.omit({ denialReply: true });
    const u = olderUpdate.safeParse(update("why?"));
    expect(u.success && !("denialReply" in u.data)).toBe(true);
    const olderMessage = ChatMessageSchema.omit({ denialReply: true });
    const m = olderMessage.safeParse(message("why?"));
    expect(m.success && !("denialReply" in m.data) && m.data.content === "x").toBe(true);
    expect(UPDATE_CLASS.tool_call_update).toBe("display");
  });
});
