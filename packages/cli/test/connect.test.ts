import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@tentacle/agent";
import { ChannelError, RemoteClient } from "@tentacle/client";
import { PermissionBroker } from "@tentacle/core";
import { Connection, SessionHost } from "@tentacle/daemon";
import { ToolRegistry } from "@tentacle/tools";
import { DomainErrorCode, RpcError, RpcPeer, createChannelPair } from "@tentacle/transport";
import { bufferedErrorSink, connectTui, tlsTrustHint } from "../src/connect.ts";
import { resolveTls } from "../src/flags.ts";
import { APP_VERSION } from "../src/version.ts";

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

// docs/feat/connect-sessions.md: quitting `connect` DETACHES (the socket closes,
// no `session/close`); `--resume` / `--continue` attach a daemon session; the
// exit line says what was left running. Each test names its mutation.
describe("connect: quit detaches, resume attaches", () => {
  /** A host whose model waits on `open()` after its first chunk ("x", then "y"). */
  function gatedHost() {
    let gates: (() => void)[] = [];
    let waiting = 0;
    const host = new SessionHost({
      defaultCwd: "/tmp",
      createAgent: () => ({
        agent: new Agent({
          model: {
            id: "m",
            async *stream(request) {
              yield { type: "text", delta: "x" };
              const last = request.messages.at(-1);
              if (last?.role === "user" && String(last.content).startsWith("gate")) {
                waiting += 1;
                await new Promise<void>((r) => {
                  gates.push(r);
                  request.signal?.addEventListener("abort", () => r(), { once: true });
                });
                waiting -= 1;
              }
              yield { type: "text", delta: "y" };
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
    const open = (): void => {
      const now = gates;
      gates = [];
      for (const r of now) r();
    };
    return { host, open, waiting: () => waiting };
  }
  const until = async (cond: () => boolean): Promise<void> => {
    for (let i = 0; i < 300 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
    if (!cond()) throw new Error(`timed out: ${String(cond)}`);
  };
  /** Drain a turn; resolves its event types (+ "turn_end:<reason>"), or "throw:<message>". */
  const drain = async (
    events:
      | AsyncIterable<{ type: string; reason?: string }>
      | Iterable<{ type: string; reason?: string }>,
  ) => {
    const seen: string[] = [];
    try {
      for await (const e of events)
        seen.push(e.type === "turn_end" ? `turn_end:${e.reason}` : e.type);
    } catch (e) {
      seen.push(`throw:${(e as Error).message}`);
    }
    return seen;
  };
  /** Another device on the same daemon. */
  async function device(host: SessionHost) {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    const client = new RemoteClient(c, new PermissionBroker());
    await client.initialize();
    return client;
  }
  /** A channel whose frames leave 10 ms after they are written (a real socket's latency). */
  function slowLink(host: SessionHost) {
    const [d, c] = createChannelPair();
    new Connection(d, host);
    return {
      send: (data: string) => {
        setTimeout(() => c.send(data), 10);
      },
      close: () => c.close(),
      setOnMessage: (h: (data: string) => void) => c.setOnMessage(h),
      setOnClose: (h: () => void) => c.setOnClose(h),
    };
  }

  test("RED: quitting mid-turn detaches — the session stays live, its turn running, re-attachable", async () => {
    // Mutation: put `closeSessions()` back on the exit path → host.size 0.
    const g = gatedHost();
    const [daemonCh, clientCh] = createChannelPair();
    const conn = new Connection(daemonCh, g.host);
    let turn: Promise<string[]> = Promise.resolve([]);
    await connectTui({ url: "ws://fake" }, () => {}, {
      dial: () => async () => clientCh,
      startTui: async (_agent, options) => {
        turn = drain(options.createSession?.().send("gate") ?? []);
        await until(() => g.waiting() === 1);
        // `/exit` mid-turn: the TUI returns at once (quitAction "exit").
      },
    });
    conn.close(); // what `ws-server` does when the socket closes
    await turn; // failed locally by the closed link — nothing rendered any more
    expect(g.host.size).toBe(1);
    expect(g.host.list({}).sessions[0]).toMatchObject({ running: true, attached: 0 });
    const id = g.host.list({}).sessions[0]?.sessionId ?? "";
    const other = await device(g.host);
    const kinds: string[] = [];
    const s = other.newSession(undefined, id, undefined, { attach: {} });
    s.watch((a) => kinds.push(a.kind));
    await s.open();
    // The history at the cut, then the running turn replayed as another device's (repro (2)).
    expect(kinds).toEqual(["history", "turn"]);
    g.open();
    await until(() => g.host.list({}).sessions[0]?.running === false);
    other.close();
  });

  test("RED (QR4): a phone's turn in the connect session survives the quit — it ends end_turn", async () => {
    const g = gatedHost();
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, g.host);
    let phoneTurn: Promise<string[]> = Promise.resolve([]);
    let phone: RemoteClient | null = null;
    await connectTui({ url: "ws://fake" }, () => {}, {
      dial: () => async () => clientCh,
      startTui: async (_agent, options) => {
        expect(await drain(options.createSession?.().send("first") ?? [])).toContain(
          "turn_end:end_turn",
        );
        const id = g.host.list({}).sessions[0]?.sessionId ?? "";
        phone = await device(g.host);
        const ps = phone.newSession(undefined, id, undefined, { attach: {} });
        await ps.open();
        phoneTurn = drain(ps.send("gate phone"));
        await until(() => g.waiting() === 1);
      },
    });
    g.open();
    expect((await phoneTurn).at(-1)).toBe("turn_end:end_turn");
    (phone as RemoteClient | null)?.close();
  });

  test("/close (or /clear) right before quitting still reaches the daemon (drain)", async () => {
    // Mutation: drop `await client.drain()` → over a slow link the close is lost; the session stays.
    const g = gatedHost();
    await connectTui({ url: "ws://fake" }, () => {}, {
      dial: () => async () => slowLink(g.host),
      startTui: async (_agent, options) => {
        const s = options.createSession?.();
        await drain(s?.send("hi") ?? []);
        s?.close?.(); // `/close`: fire-and-forget, then exit
      },
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(g.host.size).toBe(0);
  });

  test("RED: --resume <id> attaches that session (its history reaches the first controller); never a create", async () => {
    // Mutation: build the first session without `attach` → the unknown-id test creates one.
    const g = gatedHost();
    const other = await device(g.host);
    const id = crypto.randomUUID();
    await drain(other.newSession(undefined, id).send("earlier"));
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, g.host);
    const kinds: string[] = [];
    await connectTui({ url: "ws://fake", resume: { id, resume: false, latest: false } }, () => {}, {
      dial: () => async () => clientCh,
      startTui: async (_agent, options) => {
        const first = options.createSession?.();
        first?.watch?.((a) => kinds.push(a.kind));
        expect(first?.sessionId).toBe(id);
        // A later one (a /clear) is a fresh lazy session.
        expect(options.createSession?.().sessionId).not.toBe(id);
        expect(options.detachOnQuit).toBe(true);
      },
    });
    expect(kinds).toEqual(["history"]);
    expect(g.host.size).toBe(1);
    other.close();
  });

  test("RED: --resume of an unknown id fails before the TUI mounts and creates nothing", async () => {
    const g = gatedHost();
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, g.host);
    let mounted = false;
    const id = "0123456789abcdef";
    await expect(
      connectTui({ url: "ws://fake", resume: { id, resume: false, latest: false } }, () => {}, {
        dial: () => async () => clientCh,
        startTui: async () => {
          mounted = true;
        },
      }),
    ).rejects.toThrow("no session 01234567 on this daemon (ended, deleted, or never created)");
    expect(mounted).toBe(false);
    expect(g.host.size).toBe(0);
  });

  test("RED: --continue attaches the daemon's newest; on an empty daemon a new session, said before mount", async () => {
    const g = gatedHost();
    const lines: string[] = [];
    let linesAtMount = -1;
    const [d1, c1] = createChannelPair();
    new Connection(d1, g.host);
    await connectTui(
      { url: "ws://fake", resume: { resume: false, latest: true } },
      (l) => lines.push(l),
      {
        dial: () => async () => c1,
        startTui: async () => {
          linesAtMount = lines.length;
        },
      },
    );
    expect(lines[0]).toBe("[resume] no session on this daemon; starting a new one\n");
    expect(linesAtMount).toBe(1);
    const other = await device(g.host);
    const older = crypto.randomUUID();
    const newer = crypto.randomUUID();
    await drain(other.newSession(undefined, older).send("a"));
    await new Promise((r) => setTimeout(r, 5));
    await drain(other.newSession(undefined, newer).send("b"));
    const [d2, c2] = createChannelPair();
    new Connection(d2, g.host);
    let first: string | null | undefined;
    await connectTui({ url: "ws://fake", resume: { resume: false, latest: true } }, () => {}, {
      dial: () => async () => c2,
      startTui: async (_agent, options) => {
        first = options.createSession?.().sessionId;
      },
    });
    expect(first).toBe(newer);
    other.close();
  });

  test("RED: the exit line names each session left running, once, after the TUI exited; none for one never used", async () => {
    // Mutation: write the line before `startTui` returns → it lands while Ink owns the terminal.
    const g = gatedHost();
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, g.host);
    const written: string[] = [];
    let writtenDuringTui = -1;
    let id = "";
    await connectTui({ url: "ws://h:1" }, (l) => written.push(l), {
      dial: () => async () => clientCh,
      startTui: async (_agent, options) => {
        const used = options.createSession?.();
        await drain(used?.send("hi") ?? []);
        id = used?.sessionId ?? "";
        options.createSession?.(); // a fresh one, never sent to: nothing daemon-side
        writtenDuringTui = written.length;
      },
    });
    expect(writtenDuringTui).toBe(0);
    expect(written).toEqual([
      `[connect] left session ${id.slice(0, 8)} on the daemon — resume: tentacle connect ws://h:1 --resume ${id}\n`,
    ]);
  });

  test("QN2: my rows still queued at the quit are said to stay on the daemon", async () => {
    const g = gatedHost();
    const [daemonCh, clientCh] = createChannelPair();
    new Connection(daemonCh, g.host);
    const written: string[] = [];
    await connectTui({ url: "ws://h:1" }, (l) => written.push(l), {
      dial: () => async () => clientCh,
      startTui: async (_agent, options) => {
        const s = options.createSession?.();
        void drain(s?.send("gate") ?? []);
        await until(() => g.waiting() === 1);
        await s?.enqueue?.("later", "row-1");
        await until(() => (s as { stayingRows?: () => number } | undefined)?.stayingRows?.() === 1);
      },
    });
    expect(written.some((l) => l.includes("1 queued message stays on the daemon"))).toBe(true);
    g.open();
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

  test("a version skew at startup: this client's version is sent, the advice is thrown before any mount", async () => {
    // Mutations: no `clientInfo` in connectTui → the daemon never sees it; no
    // `explainVersionMismatch` in the handshake → the old daemon's bare line.
    const seen: unknown[] = [];
    const [daemonCh, clientCh] = createChannelPair();
    new RpcPeer(daemonCh, {
      onRequest: (_method, params) => {
        seen.push(params);
        // A daemon older than the report: the bare line, no `data`.
        throw new RpcError(
          DomainErrorCode.VersionMismatch,
          "protocol version mismatch: client 10, daemon 9",
        );
      },
      onNotification: () => {},
    });
    let mounted = false;
    await expect(
      connectTui({ url: "ws://fake" }, () => {}, {
        dial: () => async () => clientCh,
        startTui: async () => {
          mounted = true;
        },
      }),
    ).rejects.toThrow(
      'protocol version mismatch: client 10, daemon 9 — the daemon runs an older tentacle (it does not report its version): update the daemon: run "tentacle update" on that host and restart "tentacle serve"',
    );
    expect(mounted).toBe(false);
    expect(seen).toEqual([
      expect.objectContaining({ clientInfo: { name: "tentacle", version: APP_VERSION } }),
    ]);
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

  test("a `serve` daemon is the user's own host: the TUI is never told it is in a pod", async () => {
    // docs/feat/tui-spill-note.md: only `runPodTui` sets `daemonInPod` (spills read "saved to").
    const { dial } = capturingDial();
    let inPod: unknown = "not called";
    await connectTui({ url: "wss://fake" }, () => {}, {
      dial,
      startTui: async (_agent, options) => {
        inPod = options.daemonInPod;
      },
    });
    expect(inPod).toBeUndefined();
  });
});
