/**
 * The laptop's `RpcPeer` bounds an inbound frame (docs/fix/byte-stream-frame-cap.md):
 * a pod is not trusted (AGENTS §7), so what one frame may make us parse is capped
 * at the same `MAX_STREAM_LINE_BYTES` as the byte-stream framer.
 */
import { describe, expect, test } from "bun:test";
import { PermissionBroker } from "@tentacle/core";
import { MAX_STREAM_LINE_BYTES, createChannelPair } from "@tentacle/transport";
import { RemoteClient } from "../src/remote-client.ts";

describe("RemoteClient frame cap", () => {
  test("a frame over MAX_STREAM_LINE_BYTES is refused before parsing and reported", async () => {
    const [pod, laptopEnd] = createChannelPair();
    const errors: string[] = [];
    const laptop = new RemoteClient(laptopEnd, new PermissionBroker(), undefined, {
      onError: (e) => errors.push(e.message),
    });
    const back: string[] = [];
    pod.setOnMessage((d) => back.push(d));
    pod.send("x".repeat(MAX_STREAM_LINE_BYTES + 1));
    await new Promise((r) => setTimeout(r, 10));
    expect(back.map((d) => JSON.parse(d).error?.message)).toEqual(["frame too large"]);
    expect(errors).toEqual([
      `inbound frame of ${MAX_STREAM_LINE_BYTES + 1} units over the ${MAX_STREAM_LINE_BYTES} cap: dropped`,
    ]);
    laptop.close();
  });
});
