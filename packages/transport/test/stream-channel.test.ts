import { describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";
import { Method, PROTOCOL_VERSION } from "@tentacle/protocol";
import { RpcPeer } from "../src/peer.ts";
import {
  type NodeReadableLike,
  type NodeWritableLike,
  streamChannel,
} from "../src/stream-channel.ts";

const tick = () => new Promise((r) => setTimeout(r, 10));

/** Cross two PassThroughs into a linked channel pair (client ⇄ daemon). */
function channelPair() {
  const a2b = new PassThrough();
  const b2a = new PassThrough();
  const client = streamChannel(
    b2a as unknown as NodeReadableLike,
    a2b as unknown as NodeWritableLike,
  );
  const daemon = streamChannel(
    a2b as unknown as NodeReadableLike,
    b2a as unknown as NodeWritableLike,
  );
  return { a2b, b2a, client, daemon };
}

describe("streamChannel", () => {
  test("delivers whole newline-delimited frames both ways", async () => {
    const { client, daemon } = channelPair();
    const atDaemon: string[] = [];
    const atClient: string[] = [];
    daemon.setOnMessage((m) => atDaemon.push(m));
    client.setOnMessage((m) => atClient.push(m));

    client.send('{"id":1}');
    client.send('{"id":2}');
    daemon.send('{"ok":true}');
    await tick();

    expect(atDaemon).toEqual(['{"id":1}', '{"id":2}']);
    expect(atClient).toEqual(['{"ok":true}']);
  });

  test("reassembles a frame split across chunks, and ignores a blank line", async () => {
    const { a2b, daemon } = channelPair();
    const frames: string[] = [];
    daemon.setOnMessage((m) => frames.push(m));

    // A frame arriving in two writes, then a blank line, then a whole frame.
    a2b.write('{"half":');
    await tick();
    expect(frames).toEqual([]); // nothing complete yet
    a2b.write('1}\n\n{"whole":2}\n');
    await tick();

    expect(frames).toEqual(['{"half":1}', '{"whole":2}']);
  });

  test("fires onClose when the input stream ends", async () => {
    const { a2b, daemon } = channelPair();
    let closed = false;
    daemon.setOnClose(() => {
      closed = true;
    });
    a2b.end();
    await tick();
    expect(closed).toBe(true);
  });

  test("carries a real RpcPeer handshake round-trip (newline framing)", async () => {
    const { client, daemon } = channelPair();
    // Daemon answers the initialize handshake; client issues it.
    new RpcPeer(daemon, {
      onRequest: async (method) =>
        method === Method.Initialize
          ? {
              protocolVersion: PROTOCOL_VERSION,
              agentCapabilities: { tools: true, permissions: true },
              skills: [],
            }
          : null,
    });
    const clientPeer = new RpcPeer(client, {});

    const result = await clientPeer.request(Method.Initialize, {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: { streaming: true },
    });
    expect(result).toMatchObject({ protocolVersion: PROTOCOL_VERSION });
  });
});
