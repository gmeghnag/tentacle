import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { bufferedErrorSink, connectTui } from "../src/connect.ts";

describe("connect: buffered peer-error sink (never a raw write while Ink owns the terminal)", () => {
  test("collects errors silently, then writes them in order on flush, once", () => {
    const written: string[] = [];
    const sink = bufferedErrorSink();
    sink.onError(new Error("first"));
    sink.onError(new Error("second"));
    // Nothing is written until the TUI has exited.
    expect(written).toEqual([]);
    sink.flush((line) => written.push(line));
    expect(written).toEqual(["[connect] error: first\n", "[connect] error: second\n"]);
    sink.flush((line) => written.push(line));
    expect(written).toHaveLength(2);
  });

  test("a peer error raised while the TUI runs is written only after it exits", async () => {
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(
      daemonCh,
      new SessionHost({
        defaultCwd: "/tmp",
        createAgent: () => {
          throw new Error("no session expected");
        },
      }),
    );
    const written: string[] = [];
    let writtenDuringTui = -1;
    await connectTui({ url: "ws://fake" }, (line) => written.push(line), {
      connect: async () => clientCh as never,
      startTui: async () => {
        // A malformed frame while Ink owns the terminal.
        daemonCh.send(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: {} }));
        await new Promise((r) => setTimeout(r, 10));
        writtenDuringTui = written.length;
      },
    });
    expect(writtenDuringTui).toBe(0);
    expect(written).toEqual(["[connect] error: invalid params for notification session/update\n"]);
  });
});

describe("connect: quitting ends the sessions it opened (they outlive the socket)", () => {
  test("every session this TUI opened is closed daemon-side before the channel closes", async () => {
    // Mutation: drop `await client.closeSessions()` in connectTui → the session stays live.
    const host = new SessionHost({
      defaultCwd: "/tmp",
      createAgent: () => ({
        agent: new Agent({
          model: {
            id: "m",
            async *stream() {
              yield { type: "text", delta: "hi" };
              yield { type: "done" };
            },
          },
          tools: new ToolRegistry(),
          env: {
            id: "noop",
            exec: () => Promise.reject(new Error("unused")),
            readFile: () => Promise.reject(new Error("unused")),
            writeFile: () => Promise.reject(new Error("unused")),
          },
        }),
        permissions: new PermissionBroker(),
      }),
    });
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, host);
    let liveDuringTui = 0;
    await connectTui({ url: "ws://fake" }, () => {}, {
      connect: async () => clientCh as never,
      startTui: async (_agent, options) => {
        const session = options.createSession?.();
        for await (const _ of session?.send("hi") ?? []) {
          // drain the turn
        }
        liveDuringTui = host.size;
      },
    });
    expect(liveDuringTui).toBe(1);
    expect(host.size).toBe(0);
  });
});
