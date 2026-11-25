import { describe, expect, test } from "bun:test";
import { createRedactor, isSecretHeader, isSecretName } from "../src/index.ts";

const r = createRedactor(new Uint8Array(32).fill(7));

describe("browserRedact", () => {
  test("secret header names", () => {
    for (const n of [
      "Authorization",
      "Proxy-Authorization",
      "X-CSRF-Token",
      "x-xsrf-foo",
      "Api-Key",
      "X-Session-Id",
    ]) {
      expect(isSecretHeader(n)).toBe(true);
    }
    expect(isSecretHeader("Content-Type")).toBe(false);
    expect(isSecretHeader("Accept")).toBe(false);
  });

  test("headers: secret values masked, others kept, name kept", () => {
    const out = r.headers({ Authorization: "Bearer abc123SECRET", Accept: "text/html" });
    expect(out.Authorization).toContain("masked header Authorization");
    expect(out.Authorization).not.toContain("abc123SECRET");
    expect(out.Accept).toBe("text/html");
  });

  test("cookie header: names kept, values masked", () => {
    const out = r.cookieHeader("sid=TOPSECRET; theme=dark");
    expect(out).toContain("sid=");
    expect(out).toContain("masked cookie sid");
    expect(out).toContain("masked cookie theme");
    expect(out).not.toContain("TOPSECRET");
    expect(out).not.toContain("dark");
  });

  test("set-cookie: value masked, attributes kept", () => {
    const out = r.setCookie("sid=TOPSECRET; Path=/; HttpOnly");
    expect(out).not.toContain("TOPSECRET");
    expect(out).toContain("; Path=/; HttpOnly");
    const viaHeaders = r.headers({ "Set-Cookie": "a=111\nb=222; Secure" });
    expect(viaHeaders["Set-Cookie"]).not.toMatch(/=(111|222)/);
  });

  test("url query and fragment params by name, others untouched", () => {
    const u = r.url("https://x.test/cb?access_token=AAA&page=2&code=BBB#id_token=CCC&state=DDD");
    for (const s of ["AAA", "BBB", "CCC", "DDD"]) expect(u).not.toContain(s);
    expect(u).toContain("page=2");
    expect(u).toContain("access_token=");
  });

  test("url masking also works inside free text and percent-encoded names", () => {
    expect(r.url("see https://a.test/?pass%77ord=hunter2 ok")).not.toContain("hunter2");
    expect(r.url("see https://a.test/?q=hello")).toContain("q=hello");
  });

  test("JSON body: keys at any depth, arrays, non-string values", () => {
    const out = r.body(
      JSON.stringify({
        user: "a",
        auth: { token: "T0K", list: [{ apiKey: "K1" }] },
        pin: 1,
        secret: 12345,
      }),
      "application/json",
    );
    for (const s of ["T0K", "K1", "12345"]) expect(out).not.toContain(s);
    expect(out).toContain('"user":"a"');
  });

  test("JSON detected without a content type; urls inside values masked", () => {
    const out = r.body(JSON.stringify({ next: "https://a.test/?token=ZZZ" }));
    expect(out).not.toContain("ZZZ");
  });

  test("form body", () => {
    const out = r.body(
      "user=bob&password=hunter2&csrf_token=QQ",
      "application/x-www-form-urlencoded",
    );
    expect(out).toContain("user=bob");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("QQ");
  });

  test("multipart body", () => {
    const mp =
      '--B\r\nContent-Disposition: form-data; name="password"\r\n\r\nhunter2\r\n--B\r\nContent-Disposition: form-data; name="title"\r\n\r\nhello\r\n--B--';
    const out = r.body(mp, "multipart/form-data; boundary=B");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("hello");
  });

  test("invalid JSON falls back to the url net, never throws", () => {
    expect(r.body("{broken ?token=SECRET1")).not.toContain("SECRET1");
  });

  test("tag: stable within a redactor, different for another key and another value", () => {
    const a = createRedactor(new Uint8Array(32).fill(1));
    const b = createRedactor(new Uint8Array(32).fill(2));
    expect(a.mask("cookie", "sid", "same")).toBe(a.mask("cookie", "sid", "same"));
    expect(a.mask("cookie", "sid", "same")).not.toBe(b.mask("cookie", "sid", "same"));
    expect(a.mask("cookie", "sid", "one")).not.toBe(a.mask("cookie", "sid", "two"));
    expect(a.mask("cookie", "sid", "x".repeat(43))).toContain("43 chars");
  });

  test("default key is random per redactor", () => {
    expect(createRedactor().mask("c", "n", "v")).not.toBe(createRedactor().mask("c", "n", "v"));
  });

  test("empty values are not masked; names", () => {
    expect(r.url("?token=&x=1")).toBe("?token=&x=1");
    expect(isSecretName("code")).toBe(true);
    expect(isSecretName("page")).toBe(false);
  });
});
