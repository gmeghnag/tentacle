import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import { ChannelError } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { createChannelPair } from "@tentacle/transport";
import { bufferedErrorSink, connectTui, tlsTrustHint } from "../src/connect.ts";
import { resolveTls } from "../src/flags.ts";

describe("resolveTls (connect flags, docs/feat/client-tls-trust.md)", () => {
  const flags = (entries: [string, string][] = []) => new Map(entries);
  const bools = (names: string[] = []) => new Set(names);
  const WSS = "wss://127.0.0.1:4000";
  // A real self-signed cert (the client package's test fixture): `--ca-cert`
  // content is parsed, so a fake PEM no longer passes.
  const PEM = readFileSync(
    new URL("../../client/test/fixtures/server.pem", import.meta.url),
    "utf8",
  );

  async function withCaFile<T>(content: string, run: (path: string) => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "tls-trust-"));
    try {
      const path = join(dir, "ca.pem");
      await writeFile(path, content);
      return await run(path);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  test("no flags → undefined (the system store is used), whatever the scheme", async () => {
    expect(await resolveTls(WSS, flags(), bools())).toBeUndefined();
    expect(await resolveTls("ws://127.0.0.1:4000", flags(), bools())).toBeUndefined();
  });

  test("--ca-cert reads the PEM contents", async () => {
    await withCaFile(PEM, async (path) => {
      expect(await resolveTls(WSS, flags([["ca-cert", path]]), bools())).toEqual({ ca: PEM });
    });
  });

  test("--insecure-skip-tls-verify sets rejectUnauthorized:false", async () => {
    expect(await resolveTls(WSS, flags(), bools(["insecure-skip-tls-verify"]))).toEqual({
      rejectUnauthorized: false,
    });
  });

  test("both flags together set both fields", async () => {
    await withCaFile(PEM, async (path) => {
      expect(
        await resolveTls(WSS, flags([["ca-cert", path]]), bools(["insecure-skip-tls-verify"])),
      ).toEqual({ ca: PEM, rejectUnauthorized: false });
    });
  });

  test("a missing/unreadable --ca-cert fails loudly before any socket", async () => {
    await expect(
      resolveTls(WSS, flags([["ca-cert", "/nonexistent/no-such-ca.pem"]]), bools()),
    ).rejects.toThrow(/cannot read --ca-cert .*no-such-ca.pem/);
  });

  test("a readable but empty / non-PEM / corrupt --ca-cert fails loudly (not a later 'cannot reach')", async () => {
    for (const content of [
      "",
      "not a certificate\n",
      "-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----\n",
    ]) {
      await withCaFile(content, async (path) => {
        await expect(resolveTls(WSS, flags([["ca-cert", path]]), bools())).rejects.toThrow(
          /--ca-cert .*ca\.pem.* (contains no|has an invalid) PEM certificate/,
        );
      });
    }
    // A bundle is checked block by block: a valid first cert does not excuse a bad one.
    await withCaFile(
      `${PEM}-----BEGIN CERTIFICATE-----\nABC\n-----END CERTIFICATE-----\n`,
      async (path) => {
        await expect(resolveTls(WSS, flags([["ca-cert", path]]), bools())).rejects.toThrow(
          /has an invalid PEM certificate/,
        );
      },
    );
  });

  test("TLS flags on a non-wss:// URL are an error, not silently ignored", async () => {
    await withCaFile(PEM, async (path) => {
      await expect(
        resolveTls("ws://127.0.0.1:4000", flags([["ca-cert", path]]), bools()),
      ).rejects.toThrow("--ca-cert needs a wss:// URL");
    });
    await expect(
      resolveTls("ws://127.0.0.1:4000", flags(), bools(["insecure-skip-tls-verify"])),
    ).rejects.toThrow("--insecure-skip-tls-verify needs a wss:// URL");
    // The scheme is case-insensitive.
    expect(
      await resolveTls("WSS://127.0.0.1:4000", flags(), bools(["insecure-skip-tls-verify"])),
    ).toEqual({ rejectUnauthorized: false });
  });
});

describe("tlsTrustHint (a TLS handshake failure points at the right flag)", () => {
  const tlsFailure = new ChannelError("unreachable", "TLS handshake failed (close 1015): …", 1015);

  test("no trust configured → points at --ca-cert", () => {
    expect(tlsTrustHint(tlsFailure, undefined)).toContain("--ca-cert FILE");
  });

  test("a --ca-cert was given → asks to check it is the daemon's signer", () => {
    expect(tlsTrustHint(tlsFailure, { ca: "PEM" })).toContain(
      "check that --ca-cert is the CA that signed",
    );
  });

  test("verification skipped, or not a TLS failure → no hint", () => {
    expect(tlsTrustHint(tlsFailure, { rejectUnauthorized: false })).toBeUndefined();
    expect(
      tlsTrustHint(new ChannelError("unreachable", "cannot reach", 1006), undefined),
    ).toBeUndefined();
    expect(tlsTrustHint(new Error("boom"), undefined)).toBeUndefined();
  });

  test("connectTui rethrows the dial's TLS failure with the hint, same kind, before any mount", async () => {
    let mounted = false;
    const failure = connectTui({ url: "wss://fake" }, () => {}, {
      dial: () => async () => {
        throw tlsFailure;
      },
      startTui: async () => {
        mounted = true;
      },
    });
    await expect(failure).rejects.toThrow(/TLS handshake failed .*--ca-cert FILE/);
    await failure.catch((error: unknown) => {
      expect(error).toBeInstanceOf(ChannelError);
      expect((error as ChannelError).kind).toBe("unreachable");
    });
    expect(mounted).toBe(false);
  });
});

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

describe("connect: TLS trust passthrough + insecure warning (docs/feat/client-tls-trust.md)", () => {
  // A dial that records the options it was given and returns a ready channel
  // (a real `Connection` on the far end so `initialize` succeeds).
  function capturingDial() {
    const seen: Array<{ url: string; options: { token?: string; tls?: unknown } }> = [];
    return {
      seen,
      dial: (url: string, options: { token?: string; tls?: unknown }) => {
        seen.push({ url, options });
        return async () => {
          const [daemonCh, clientCh] = createChannelPair();
          new Connection(
            daemonCh,
            new SessionHost({
              defaultCwd: "/tmp",
              createAgent: () => {
                throw new Error("initialize only: no agent");
              },
            }),
          );
          return clientCh;
        };
      },
    };
  }

  test("tls is passed to the dial options; an insecure knob warns via the sink (not a raw write)", async () => {
    const { seen, dial } = capturingDial();
    const written: string[] = [];
    const tls = { rejectUnauthorized: false };
    await connectTui({ url: "wss://fake", token: "t", tls }, (line) => written.push(line), {
      dial,
      startTui: async () => {
        // The warning must NOT have leaked while Ink owns the terminal.
        expect(written.filter((l) => l.includes("insecure"))).toEqual([]);
      },
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.options).toEqual({ token: "t", tls });
    // The dev-only warning is flushed after the TUI exits (AGENTS §7).
    expect(written.some((l) => l.includes("--insecure-skip-tls-verify"))).toBe(true);
  });

  test("no insecure knob → no warning", async () => {
    const { dial } = capturingDial();
    const written: string[] = [];
    await connectTui({ url: "wss://fake", tls: { ca: "PEM" } }, (line) => written.push(line), {
      dial,
      startTui: async () => {},
    });
    expect(written).toEqual([]);
  });
});
