import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONTROL_MAX_BYTES,
  type ControlRequest,
  controlSocketPath,
  dialControl,
  parseControl,
  parseReply,
  serveControl,
} from "../src/control-socket.ts";

const V = { schemaVersion: 1 };
const UID = "11111111-1111-4111-8111-111111111111";

describe("H24 parseControl: newline JSON, 4 KiB, strict (docs/feat/detached-handover.md)", () => {
  test("the two ops, and nothing else", () => {
    expect(parseControl(JSON.stringify({ ...V, op: "prepare", sessionId: UID }))).toEqual({
      ok: true,
      request: { op: "prepare", sessionId: UID },
    });
    expect(parseControl(JSON.stringify({ ...V, op: "commit" }))).toEqual({
      ok: true,
      request: { op: "commit" },
    });
    for (const bad of [
      "{not json",
      "[]",
      JSON.stringify({ ...V, op: "stop" }),
      JSON.stringify({ ...V, op: "prepare" }),
      JSON.stringify({ ...V, op: "prepare", sessionId: "" }),
      JSON.stringify({ op: "commit" }),
    ]) {
      expect(parseControl(bad)).toEqual({ ok: false, reason: "invalid" });
    }
    expect(parseControl(JSON.stringify({ schemaVersion: 2, op: "commit" }))).toEqual({
      ok: false,
      reason: "version",
    });
    const big = JSON.stringify({ ...V, op: "prepare", sessionId: "x".repeat(CONTROL_MAX_BYTES) });
    expect(parseControl(big)).toEqual({ ok: false, reason: "invalid" });
  });

  test("replies: strict too", () => {
    expect(
      parseReply(JSON.stringify({ ...V, ok: true, appVersion: "1", autoAccept: true })),
    ).toEqual({ ok: true, appVersion: "1", autoAccept: true });
    expect(parseReply(JSON.stringify({ ...V, ok: false, reason: "busy" }))).toEqual({
      ok: false,
      reason: "busy",
    });
    expect(parseReply(JSON.stringify({ ...V, ok: false, reason: "pwned" }))).toBeNull();
    expect(parseReply(JSON.stringify({ schemaVersion: 9, ok: true }))).toBeNull();
  });
});

describe("H24 controlSocketPath", () => {
  test("in the run dir when it fits; past 103 bytes, the private fallback", () => {
    const tmp = mkdtempSync(join(tmpdir(), "ctl-"));
    const short = join(tmp, "r");
    expect(controlSocketPath(short, "abc", { tmp, uid: 501 })).toBe(join(short, "control.sock"));
    const long = join(tmp, "x".repeat(120));
    const fallback = controlSocketPath(long, "0123456789abcdef", {
      tmp,
      uid: process.getuid?.() ?? 0,
    });
    expect(fallback).toBe(
      join(tmp, `tentacle-${process.getuid?.() ?? 0}`, "0123456789abcdef.sock"),
    );
    expect(statSync(join(tmp, `tentacle-${process.getuid?.() ?? 0}`)).mode & 0o777).toBe(0o700);
  });

  test("a fallback dir of the wrong mode, or not ours: no socket", () => {
    // Mutation: skip the mode check → a socket in a dir others can enter.
    const tmp = mkdtempSync(join(tmpdir(), "ctl-"));
    const uid = process.getuid?.() ?? 0;
    const shared = join(tmp, `tentacle-${uid}`);
    mkdirSync(shared, { mode: 0o755 });
    chmodSync(shared, 0o755);
    const long = join(tmp, "x".repeat(120));
    expect(controlSocketPath(long, "0123456789abcdef", { tmp, uid })).toBeNull();
    const other = mkdtempSync(join(tmpdir(), "ctl-"));
    mkdirSync(join(other, `tentacle-${uid + 1}`), { mode: 0o700 });
    expect(controlSocketPath(long, "0123456789abcdef", { tmp: other, uid: uid + 1 })).toBeNull();
  });
});

describe("control socket, served and dialled", () => {
  test("a request gets its reply; the server sees the peer close; the file is 0600 and goes with close", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl-"));
    const path = join(dir, "control.sock");
    const seen: ControlRequest[] = [];
    let closed = 0;
    const server = await serveControl(path, {
      onRequest: async (request) => {
        seen.push(request);
        return request.op === "prepare"
          ? { ok: true, appVersion: "9", autoAccept: false }
          : { ok: false, reason: "busy" };
      },
      onClose: () => {
        closed += 1;
      },
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const conn = await dialControl(path);
    if (!conn) throw new Error("no conn");
    expect(await conn.send({ op: "prepare", sessionId: UID })).toEqual({
      ok: true,
      appVersion: "9",
      autoAccept: false,
    });
    expect(await conn.send({ op: "commit" })).toEqual({ ok: false, reason: "busy" });
    conn.close();
    for (let i = 0; i < 100 && closed === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(closed).toBe(1);
    expect(seen.map((r) => r.op)).toEqual(["prepare", "commit"]);
    server.close();
    expect(existsSync(path)).toBe(false);
    expect(await dialControl(path)).toBeNull(); // ENOENT
  });

  test("an unreadable frame is answered `invalid`/`version`, never handled", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ctl-"));
    const path = join(dir, "control.sock");
    let handled = 0;
    const server = await serveControl(path, {
      onRequest: async () => {
        handled += 1;
        return { ok: true };
      },
      onClose: () => {},
    });
    const lines = await new Promise<string>((resolve) => {
      const { createConnection } = require("node:net") as typeof import("node:net");
      const socket = createConnection(path, () => {
        socket.write(`${JSON.stringify({ schemaVersion: 2, op: "commit" })}\n{bad\n`);
      });
      let text = "";
      socket.on("data", (d) => {
        text += String(d);
        if (text.split("\n").length > 2) {
          socket.end();
          resolve(text);
        }
      });
    });
    expect(
      lines
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l)),
    ).toEqual([
      { ...V, ok: false, reason: "version" },
      { ...V, ok: false, reason: "invalid" },
    ]);
    expect(handled).toBe(0);
    server.close();
  });
});
