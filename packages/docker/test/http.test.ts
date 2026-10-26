import { describe, expect, test } from "bun:test";
import { HttpParseError, MAX_HEAD_BYTES, ResponseReader, buildRequest } from "../src/http.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Push `text` one byte at a time; return the first completed response. */
function pushBytewise(reader: ResponseReader, bytes: Uint8Array) {
  let res: ReturnType<ResponseReader["push"]>;
  for (let i = 0; i < bytes.length && res === undefined; i++) {
    res = reader.push(bytes.subarray(i, i + 1));
  }
  return res;
}

describe("buildRequest", () => {
  test("a JSON POST: exact bytes, Host: docker, Content-Type + Content-Length", () => {
    const bytes = buildRequest({
      method: "POST",
      path: "/v1.52/containers/c1/exec",
      headers: { Connection: "close" },
      body: { Cmd: ["cat"] },
    });
    expect(dec.decode(bytes)).toBe(
      'POST /v1.52/containers/c1/exec HTTP/1.1\r\nHost: docker\r\nContent-Type: application/json\r\nContent-Length: 15\r\nConnection: close\r\n\r\n{"Cmd":["cat"]}',
    );
  });

  test("a body-less POST says Content-Length: 0; a GET sends no length", () => {
    expect(dec.decode(buildRequest({ method: "POST", path: "/x" }))).toBe(
      "POST /x HTTP/1.1\r\nHost: docker\r\nContent-Length: 0\r\n\r\n",
    );
    expect(dec.decode(buildRequest({ method: "GET", path: "/_ping" }))).toBe(
      "GET /_ping HTTP/1.1\r\nHost: docker\r\n\r\n",
    );
  });

  test("refuses a header that would inject a line", () => {
    expect(() =>
      buildRequest({ method: "GET", path: "/", headers: { X: "a\r\nEvil: 1" } }),
    ).toThrow(/invalid HTTP header/);
  });
});

describe("ResponseReader", () => {
  test("a Content-Length response split byte by byte", () => {
    const raw = enc.encode(
      'HTTP/1.1 201 Created\r\nContent-Type: application/json\r\nContent-Length: 11\r\n\r\n{"Id":"e1"}',
    );
    const res = pushBytewise(new ResponseReader(), raw);
    expect(res?.status).toBe(201);
    expect(res?.reason).toBe("Created");
    expect(res?.headers.get("content-type")).toBe("application/json");
    expect(dec.decode(res?.body)).toBe('{"Id":"e1"}');
  });

  test("header names are case-insensitive; repeats are joined", () => {
    const res = new ResponseReader().push(
      enc.encode(
        "HTTP/1.1 200 OK\r\nAPI-Version: 1.52\r\nX-A: 1\r\nx-a: 2\r\nContent-Length: 0\r\n\r\n",
      ),
    );
    expect(res?.headers.get("api-version")).toBe("1.52");
    expect(res?.headers.get("x-a")).toBe("1, 2");
  });

  test("a chunked body with chunk extensions, trailers, and a CRLF split across pushes", () => {
    const raw =
      "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n5;ext=1\r\nhello\r\n7\r\n, world\r\n0\r\nX-Trailer: t\r\n\r\n";
    // Byte by byte splits every CRLF (incl. the one after each chunk's data).
    const res = pushBytewise(new ResponseReader(), enc.encode(raw));
    expect(dec.decode(res?.body)).toBe("hello, world");
    // And in two halves at an awkward offset (between the \r and \n after "hello").
    const cut = raw.indexOf("hello") + 6;
    const reader = new ResponseReader();
    expect(reader.push(enc.encode(raw.slice(0, cut)))).toBeUndefined();
    expect(dec.decode(reader.push(enc.encode(raw.slice(cut)))?.body)).toBe("hello, world");
  });

  test("a bad chunk size is a parse error", () => {
    const reader = new ResponseReader();
    expect(() =>
      reader.push(enc.encode("HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nzz\r\n")),
    ).toThrow(HttpParseError);
  });

  test("an EOF-delimited body completes on end(); a truncated length body throws", () => {
    const reader = new ResponseReader();
    expect(reader.push(enc.encode("HTTP/1.1 200 OK\r\n\r\npart1 "))).toBeUndefined();
    expect(reader.push(enc.encode("part2"))).toBeUndefined();
    expect(dec.decode(reader.end().body)).toBe("part1 part2");

    const cut = new ResponseReader();
    cut.push(enc.encode("HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nabc"));
    expect(() => cut.end()).toThrow(/closed mid-body/);
    expect(() => new ResponseReader().end()).toThrow(/closed before a response/);
  });

  test("204/304 have no body even without a length", () => {
    expect(new ResponseReader().push(enc.encode("HTTP/1.1 204 No Content\r\n\r\n"))?.status).toBe(
      204,
    );
    expect(new ResponseReader().push(enc.encode("HTTP/1.1 304 Not Modified\r\n\r\n"))?.status).toBe(
      304,
    );
  });

  test("a 101 with stream bytes in the SAME push keeps them as leftover", () => {
    const reader = new ResponseReader({ headOnly: (h) => h.status === 101 });
    const frame = [1, 0, 0, 0, 0, 0, 0, 3, 0x61, 0x62, 0x63];
    const raw = new Uint8Array([
      ...enc.encode(
        "HTTP/1.1 101 UPGRADED\r\nContent-Type: application/vnd.docker.raw-stream\r\nConnection: Upgrade\r\nUpgrade: tcp\r\n\r\n",
      ),
      ...frame,
    ]);
    const res = reader.push(raw);
    expect(res?.status).toBe(101);
    expect(res?.body.length).toBe(0);
    expect(Array.from(reader.leftover())).toEqual(frame);
  });

  test("a head larger than 64 KiB is refused", () => {
    const reader = new ResponseReader();
    const big = enc.encode(`HTTP/1.1 200 OK\r\nX: ${"a".repeat(MAX_HEAD_BYTES)}`);
    expect(() => reader.push(big)).toThrow(/no end of headers within 64 KiB/);
  });

  test("a non-HTTP status line is refused", () => {
    expect(() => new ResponseReader().push(enc.encode("SSH-2.0-OpenSSH_9.6\r\n\r\n"))).toThrow(
      /malformed response from the engine: bad status line "SSH-2.0-OpenSSH_9.6"/,
    );
  });
});
