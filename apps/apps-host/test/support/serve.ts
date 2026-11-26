/** A fake `serve`: the signed tunnel upgrade, the frames it got, and answers. */
import {
  type TunnelFrame,
  type TunnelRequest,
  decodeTunnelFrame,
  encodeTunnelFrame,
} from "@tentacle/protocol";
import { DOMAIN, type startHost, until } from "./host.ts";
import type { Publisher } from "./publisher.ts";

export type Host = Awaited<ReturnType<typeof startHost>>;

export interface FakeServe {
  readonly socket: WebSocket;
  readonly frames: TunnelFrame[];
  /** The requests of the `OPEN`s received, in order. */
  opens(): { stream: number; request: TunnelRequest }[];
  of(stream: number): TunnelFrame[];
  opened(): boolean;
  closed(): { code: number; reason: string } | undefined;
  send(frame: TunnelFrame): void;
  sendRaw(bytes: Uint8Array): void;
  /** `HEAD`, the body in one `DATA`, `END`. */
  reply(stream: number, body: string, headers?: [string, string][], status?: number): void;
}

export async function liveApp(host: Host, publisher: Publisher): Promise<string> {
  const response = await host.signed(publisher, "POST", "/v1/apps/live");
  if (response.status !== 201) {
    throw new Error(`live: ${response.status} ${await response.text()}`);
  }
  return ((await response.json()) as { id: string }).id;
}

export const tunnelHeaders = (
  host: Host,
  publisher: Publisher,
  id: string,
  nonce?: string,
): Promise<Record<string, string>> =>
  publisher.headers({
    method: "GET",
    path: `/v1/apps/${id}/tunnel`,
    domain: DOMAIN,
    date: host.clock.at,
    ...(nonce === undefined ? {} : { nonce }),
  });

/** Dial the tunnel with the given headers; does not wait. */
export function dial(
  host: Host,
  id: string,
  headers: Record<string, string>,
  onFrame?: (frame: TunnelFrame, serve: FakeServe) => void,
): FakeServe {
  const socket = new WebSocket(`ws://127.0.0.1:${host.server.port}/v1/apps/${id}/tunnel`, {
    headers: { host: DOMAIN, ...headers },
  } as unknown as string[]);
  socket.binaryType = "arraybuffer";
  const frames: TunnelFrame[] = [];
  let opened = false;
  let closed: { code: number; reason: string } | undefined;
  const send = (frame: TunnelFrame): void => {
    const bytes = encodeTunnelFrame(frame);
    if (bytes === undefined) {
      throw new Error(`unencodable ${frame.type}`);
    }
    socket.send(bytes);
  };
  const serve: FakeServe = {
    socket,
    frames,
    opens: () => frames.flatMap((f) => (f.type === "open" ? [f] : [])),
    of: (stream) => frames.filter((f) => f.stream === stream),
    opened: () => opened,
    closed: () => closed,
    send,
    sendRaw: (bytes) => socket.send(bytes),
    reply(stream, body, headers = [["content-type", "text/plain"]], status = 200) {
      send({ type: "head", stream, response: { status, headers } });
      if (body !== "") {
        send({ type: "data", stream, bytes: new TextEncoder().encode(body) });
      }
      send({ type: "end", stream });
    },
  };
  socket.onopen = () => {
    opened = true;
  };
  socket.onclose = (event) => {
    closed = { code: event.code, reason: event.reason };
  };
  socket.onmessage = (event) => {
    const frame = decodeTunnelFrame(new Uint8Array(event.data as ArrayBuffer));
    if (frame !== undefined) {
      frames.push(frame);
      onFrame?.(frame, serve);
    }
  };
  return serve;
}

/** A connected tunnel: waits until the host has registered it. */
export async function connect(
  host: Host,
  publisher: Publisher,
  id: string,
  onFrame?: (frame: TunnelFrame, serve: FakeServe) => void,
): Promise<FakeServe> {
  const serve = dial(host, id, await tunnelHeaders(host, publisher, id), onFrame);
  await until(() => serve.opened() && host.server.tunnels.has(id));
  return serve;
}
