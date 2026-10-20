import { describe, expect, test } from "bun:test";
import { Agent } from "@tentacle/agent";
import { ChannelError } from "@tentacle/client";
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
      dial: () => async () => clientCh,
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
      dial: () => async () => clientCh,
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

describe("connect: the reconnecting client (docs/feat/client-reattach-frontends.md §5)", () => {
  test("one factory opens the first channel and every redial; the session id is ours; the link reaches the TUI", async () => {
    // Mutations: no `channelFactory` → the drop is terminal (the turn fails);
    // `newSession()` without an id → the open carries none.
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
    const opened: unknown[] = [];
    let dials = 0;
    let current: ReturnType<typeof createChannelPair>[0] | null = null;
    const dial = () => async () => {
      dials += 1;
      const [daemonCh, clientCh] = createChannelPair();
      current = daemonCh;
      new Connection(daemonCh, host);
      return {
        send: (data: string) => {
          const frame = JSON.parse(data) as { method?: string; params?: { sessionId?: unknown } };
          if (frame.method === "session/open") opened.push(frame.params?.sessionId);
          clientCh.send(data);
        },
        close: () => clientCh.close(),
        setOnMessage: (h: (data: string) => void) => clientCh.setOnMessage(h),
        setOnClose: (h: () => void) => clientCh.setOnClose(h),
      };
    };
    const states: string[] = [];
    let text = "";
    await connectTui({ url: "ws://fake" }, () => {}, {
      dial,
      startTui: async (_agent, options) => {
        options.link?.onLinkStatus((s) => states.push(s.state));
        const session = options.createSession?.();
        for await (const e of session?.send("one") ?? []) {
          if (e.type === "text") text += e.delta;
        }
        current?.close(); // the network drops while idle
        for (let i = 0; i < 200 && states.at(-1) !== "up"; i++) {
          await new Promise((r) => setTimeout(r, 5));
        }
        for await (const e of session?.send("two") ?? []) {
          if (e.type === "text") text += e.delta;
        }
      },
    });
    expect(dials).toBe(2);
    expect(states).toContain("reconnecting");
    expect(text).toBe("hihi");
    expect(opened.length).toBeGreaterThanOrEqual(2);
    expect(String(opened[0])).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Set(opened).size).toBe(1); // re-attached by the same id
  });

  test("a rejected token at startup surfaces the factory's message before the TUI mounts", async () => {
    let mounted = false;
    await expect(
      connectTui({ url: "ws://fake", token: "bad" }, () => {}, {
        dial: () => async () => {
          throw new ChannelError("unauthorized", "the daemon answered 401 to the token");
        },
        startTui: async () => {
          mounted = true;
        },
      }),
    ).rejects.toThrow(/401/);
    expect(mounted).toBe(false);
  });
});
