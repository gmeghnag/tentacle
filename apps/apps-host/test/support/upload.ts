/**
 * A raw HTTP upload a test drives byte by byte: it declares a length (or sends
 * chunks), holds the request open, and then finishes or drops it.
 */
import { type Socket, connect } from "node:net";

export interface Upload {
  /** The response's status, whenever it comes (throws after two seconds). */
  status(): Promise<number>;
  /** Send the rest, end the body, and wait for the status. */
  finish(rest: string): Promise<number>;
  abort(): void;
}

const open = new Set<Socket>();

export function closeUploads(): void {
  for (const socket of open) {
    socket.destroy();
  }
  open.clear();
}

export async function openUpload(
  port: number,
  input: {
    readonly path: string;
    readonly headers: Record<string, string>;
    readonly declared: number | "chunked";
    readonly first: string;
  },
): Promise<Upload> {
  const chunked = input.declared === "chunked";
  const frame = (text: string): string =>
    chunked ? `${Buffer.byteLength(text).toString(16)}\r\n${text}\r\n` : text;
  let received = "";
  const socket = connect(port, "127.0.0.1");
  open.add(socket);
  socket.on("data", (data) => {
    received += data.toString("latin1");
  });
  socket.on("error", () => {});
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  const head = [
    `POST ${input.path} HTTP/1.1`,
    ...Object.entries(input.headers).map(([name, value]) => `${name}: ${value}`),
    chunked ? "transfer-encoding: chunked" : `content-length: ${input.declared}`,
  ].join("\r\n");
  socket.write(`${head}\r\n\r\n${frame(input.first)}`);

  const status = async (): Promise<number> => {
    const deadline = Date.now() + 2000;
    for (;;) {
      const match = /^HTTP\/1\.1 (\d{3})/.exec(received);
      if (match !== null) {
        return Number(match[1]);
      }
      if (Date.now() > deadline) {
        throw new Error("no response");
      }
      await Bun.sleep(2);
    }
  };
  return {
    status,
    finish(rest) {
      socket.write(`${frame(rest)}${chunked ? "0\r\n\r\n" : ""}`);
      return status();
    },
    abort() {
      socket.destroy();
    },
  };
}
