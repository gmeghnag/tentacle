/**
 * The pure half of `workload_shell` (docs/feat/workload-shell.md D2): bootstrap
 * and command lines, the incremental sentinel parser, the bounded capture
 * window, the kill script and the state machine. No I/O, no React — every rule
 * is a function, so a bug is understood and tested in one place.
 */
import { describe, expect, test } from "bun:test";
import {
  BOOTSTRAP_NONCE,
  CaptureWindow,
  NONCE_BYTES,
  OUTPUT_HEAD_BYTES,
  OUTPUT_TAIL_BYTES,
  READY_PREFIX,
  bootstrapLine,
  bytesAfterReady,
  commandLine,
  escapeSingleQuoted,
  formatBody,
  killTreeScript,
  makeNonce,
  parseReady,
  resultText,
  separateLines,
  stripLeadingNewline,
} from "../src/workload-shell-frame.ts";

const enc = new TextEncoder();
const dec = new TextDecoder();

describe("escapeSingleQuoted", () => {
  test("a plain command is unchanged", () => {
    expect(escapeSingleQuoted("ls -la")).toBe("ls -la");
  });

  test("single quotes round-trip through a real sh", () => {
    // The lexical claim, checked the way the pod checks it: sh executes it.
    const cases = ["echo 'x'", "echo 'it'\\''s'", "echo $HOME", 'echo "a b"', "printf 'a\\tb'"];
    for (const c of cases) {
      expect(escapeSingleQuoted(c)).toBe(c.replaceAll("'", "'\\''"));
    }
  });

  test("a backslash, a dollar sign and a newline survive as themselves", () => {
    for (const c of ["echo a\\nb", "echo $X", "printf 'a\\nb'", "line1\nline2"]) {
      expect(escapeSingleQuoted(c)).toBe(c.replaceAll("'", "'\\''"));
    }
  });
});

describe("makeNonce", () => {
  test("is NONCE_BYTES of hex, and two draws differ", () => {
    const a = makeNonce();
    const b = makeNonce();
    expect(a).toMatch(/^[0-9a-f]+$/);
    expect(a.length).toBe(NONCE_BYTES * 2);
    expect(a).not.toBe(b); // 128 bits: a collision is not a thing that happens
  });
});

describe("bootstrapLine", () => {
  test("names the shell's pid and initial cwd, and is CONSTANT apart from the nonce", () => {
    const line = bootstrapLine("abc123");
    expect(line).toContain("abc123");
    expect(line).toContain("$$");
    expect(line).toContain("$PWD");
    // The §4 pin: nothing from the daemon's environment can leak into the pod.
    expect(line).not.toContain("TENTACLE_");
    expect(line).not.toContain("${");
    expect(line).not.toMatch(/API_KEY|TOKEN|SECRET/i);
    // Apart from the nonce, two draws are the same text.
    expect(bootstrapLine("abc123").replaceAll("abc123", "N")).toBe(
      bootstrapLine("zzz999").replaceAll("zzz999", "N"),
    );
  });
});

describe("parseReady", () => {
  test("finds the pid and the initial cwd", () => {
    const text = `noise\n${READY_PREFIX}4242_/home/app__TNT__E\n`;
    expect(parseReady(text, BOOTSTRAP_NONCE.length)).toEqual({
      kind: "ready",
      pid: 4242,
      cwd: "/home/app",
    });
  });

  test("a pid that is not a number is not ready", () => {
    expect(parseReady(`${READY_PREFIX}abc_/x__TNT__E`, 0)).toBeNull();
  });
  test("nothing ready yet", () => {
    expect(parseReady("starting up\n", 0)).toBeNull();
  });
});

describe("bytesAfterReady", () => {
  const ready = `${READY_PREFIX}4242_/home/app__TNT__E\n`;
  const show = (bytes: Uint8Array<ArrayBuffer> | null): string | null =>
    bytes === null ? null : dec.decode(bytes);

  test("is the tail after the marker, without the newline our own printf adds", () => {
    expect(show(bytesAfterReady(enc.encode(`${ready}banner line\n`)))).toBe("banner line\n");
  });

  test("is empty when the marker ends the read, and null before the marker is whole", () => {
    expect(show(bytesAfterReady(enc.encode(ready)))).toBe("");
    expect(show(bytesAfterReady(enc.encode("starting up\n")))).toBeNull();
    expect(show(bytesAfterReady(enc.encode(ready.slice(0, 20))))).toBeNull();
  });

  test("a pod line holding the END sequence BEFORE the marker cannot move the cut", () => {
    // The two halves of this handshake must agree: `parseReady` scans from the
    // ready PREFIX, so this cut does too. Cutting at the first `__TNT__E` found
    // anywhere would hand the ready marker itself (delimiter and all) to the
    // first command's scanner as its output — fix round 2's HIGH finding.
    const body = `container says __TNT__E hello\n${ready}real output\n`;
    expect(show(bytesAfterReady(enc.encode(body)))).toBe("real output\n");
  });
});

describe("commandLine", () => {
  test("wraps the command in `command eval`, sends stdin from /dev/null, merges stderr, and ends with the sentinel", () => {
    const line = commandLine("ls", "N0NCE");
    expect(line).toContain("command eval 'ls'");
    expect(line).toContain("</dev/null");
    expect(line).toContain("2>&1");
    expect(line).toContain("__TNT_");
    expect(line).toContain("N0NCE");
    expect(line.endsWith("\n")).toBe(true);
  });

  test("a quote in the command cannot break out of the eval string", () => {
    const line = commandLine("echo 'x'; rm -rf /", "N1");
    // The escaped form only, never a bare closing quote around the payload.
    expect(line).toContain("echo '\\''x'\\''; rm -rf /");
  });
});

describe("stripLeadingNewline", () => {
  test("removes exactly ONE leading newline (ours), not the command's own blank line", () => {
    expect(dec.decode(stripLeadingNewline(enc.encode("\nhello")))).toBe("hello");
    expect(dec.decode(stripLeadingNewline(enc.encode("\n\nhello")))).toBe("\nhello");
    expect(dec.decode(stripLeadingNewline(enc.encode("hello")))).toBe("hello");
    expect(dec.decode(stripLeadingNewline(new Uint8Array(0)))).toBe("");
  });
});

describe("separateLines", () => {
  test("splits the decoded output into lines, preserving blank lines", () => {
    expect(separateLines("a\n\nb\n")).toEqual(["a", "", "b"]);
    expect(separateLines("")).toEqual([]);
  });
});

describe("the sentinel parser", () => {
  const nonce = "abc";
  const begin = `__TNT_${nonce}_B_`;
  const endMarker = `__TNT_${nonce}_E`;

  function full(code: number | string, cwd: string): string {
    return `\n__TNT_${nonce}_B_${code}_${cwd}${endMarker}\n`;
  }

  test("finds output then done, and reports the code and cwd", () => {
    const window = new CaptureWindow();
    const events: string[] = [];
    const parser = window.parser(nonce, (e) => {
      if (e.kind === "output") {
        events.push(`out:${dec.decode(e.bytes)}`);
      } else {
        events.push(`done:${e.code}:${e.cwd}`);
      }
    });
    expect(begin.length).toBeGreaterThan(0);
    parser.push(enc.encode(`hello\n${full(0, "/etc")}`));
    expect(events).toEqual(["out:hello\n", "done:0:/etc"]);
  });

  test("the sentinel is found when the input is split at EVERY byte offset", () => {
    const payload = `hello world\n${full(7, "/srv")}`;
    const bytes = enc.encode(payload);
    for (let cut = 1; cut < bytes.length; cut++) {
      const window = new CaptureWindow();
      const seen: string[] = [];
      const parser = window.parser(nonce, (e) => {
        if (e.kind === "done") {
          seen.push(`done:${e.code}:${e.cwd}`);
        }
      });
      parser.push(bytes.subarray(0, cut));
      parser.push(bytes.subarray(cut));
      expect(seen, `split at ${cut}`).toEqual(["done:7:/srv"]);
      expect(window.text()).toBe("hello world\n");
    }
  });

  test("a cwd containing `_`, `__` and a newline still parses", () => {
    for (const cwd of ["/a_b", "/a__b", "/a\nb", "/x_y__z"]) {
      const window = new CaptureWindow();
      let got: { code: number; cwd: string } | undefined;
      const parser = window.parser(nonce, (e) => {
        if (e.kind === "done") {
          got = { code: e.code, cwd: e.cwd };
        }
      });
      parser.push(enc.encode(`out\n${full(3, cwd)}`));
      expect(got, cwd).toEqual({ code: 3, cwd });
    }
  });

  test("a wrong nonce is ignored (its marker is just output)", () => {
    const window = new CaptureWindow();
    const events: string[] = [];
    const parser = window.parser(nonce, (e) => {
      events.push(e.kind);
    });
    parser.push(enc.encode("__TNT_other_B_0_/x__TNT_other_E\ntail\n"));
    expect(events.every((k) => k === "output")).toBe(true);
    parser.push(enc.encode(full(0, "/ok")));
    expect(events[events.length - 1]).toBe("done");
  });

  test("NUL bytes and binary cannot hide the sentinel", () => {
    const window = new CaptureWindow();
    let done = false;
    const parser = window.parser(nonce, (e) => {
      if (e.kind === "done") {
        done = true;
      }
    });
    parser.push(new Uint8Array([0x00, 0xff, 0x00]));
    parser.push(enc.encode(full(0, "/x")));
    expect(done).toBe(true);
  });
});

describe("CaptureWindow", () => {
  test("keeps a bounded head and tail, counts what it dropped", () => {
    const window = new CaptureWindow();
    const parser = window.parser("abc", () => {});
    const chunk = enc.encode("x".repeat(64 * 1024));
    for (let i = 0; i < 64; i++) {
      parser.push(chunk); // 4 MiB total
    }
    parser.flush(); // release the marker carry the parser holds back
    expect(window.dropped).toBeGreaterThan(0);
    expect(window.total).toBe(64 * 64 * 1024); // every byte reached the window
    const body = window.text();
    expect(body.length).toBeLessThanOrEqual(OUTPUT_HEAD_BYTES + OUTPUT_TAIL_BYTES + 64);
  });

  test("short output is kept whole, nothing dropped", () => {
    const window = new CaptureWindow();
    const parser = window.parser("abc", () => {});
    parser.push(enc.encode("short\n"));
    parser.flush(); // the parser holds a marker carry until told the stream ended
    expect(window.dropped).toBe(0);
    expect(window.text()).toBe("short\n");
  });

  test("binary detection: a NUL or many replacement chars", () => {
    const nul = new CaptureWindow();
    const parser = nul.parser("abc", () => {});
    parser.push(new Uint8Array([0x61, 0x00, 0x62]));
    parser.flush();
    expect(nul.binary()).toBe(true);
    expect(nul.text()).toContain("binary output");

    const text = new CaptureWindow();
    const textParser = text.parser("abc", () => {});
    textParser.push(enc.encode("hello\n"));
    textParser.flush();
    expect(text.binary()).toBe(false);
    expect(text.text()).toBe("hello\n");
  });
});

describe("formatBody", () => {
  test("states the count of bytes omitted from the middle", () => {
    expect(formatBody("head", "tail", 1234)).toBe(
      "head\n[N bytes omitted from the middle]\ntail".replace("N", "1234"),
    );
  });

  test("no omission → just the body", () => {
    expect(formatBody("all", "", 0)).toBe("all");
  });
});

describe("killTreeScript", () => {
  test("walks /proc for ppid, kills descendants, and excludes the shell unless asked", () => {
    const script = killTreeScript(4242, "TERM");
    expect(script).toContain("/proc/[0-9]*");
    expect(script).toContain("/stat");
    expect(script).toContain("kill -TERM");
    expect(script).toContain("4242");
    expect(script).not.toContain("pkill"); // POSIX sh + /proc only (busybox-safe)
    expect(script).toContain("cut"); // the ppid is read from the stat line, not guessed
  });

  test("never kills itself: the script IS a descendant of the target when run under the shell", () => {
    const script = killTreeScript(4242, "KILL", { includeSelf: true });
    // Live-verified on alpine/dash/bash (Execution): without this guard the
    // script killed itself and left the rest of the tree alive.
    expect(script).toContain('[ "$__tnt_p" = "$$" ] && continue');
  });

  test("includeSelf also kills the shell itself", () => {
    const without = killTreeScript(7, "KILL");
    const with_ = killTreeScript(7, "KILL", { includeSelf: true });
    expect(with_).not.toBe(without);
    expect(with_.split("\n").length).toBeGreaterThan(without.split("\n").length - 1);
  });
});

describe("resultText", () => {
  const base = {
    exitCode: 0,
    cwd: "/etc",
    target: "kubernetes default/api-0" as const,
    seconds: 0.4,
    body: "ok",
    dropped: 0,
    notices: [],
  };

  test("the header leads with exit= (the shellTool convention) and names engine, target, cwd and time", () => {
    const text = resultText(base);
    expect(text.content.startsWith("exit=0")).toBe(true);
    expect(text.content).toContain("cwd=/etc");
    expect(text.content).toContain("kubernetes default/api-0");
    expect(text.content).toContain("ok");
  });

  test("a non-zero exit is an error; a clean one is not", () => {
    expect(resultText(base).isError).toBe(false);
    expect(resultText({ ...base, exitCode: 2 }).isError).toBe(true);
  });

  test("any notice makes it an error, even at exit 0 (the state was lost)", () => {
    const text = resultText({ ...base, notices: ["[connection lost — outcome unknown]"] });
    expect(text.isError).toBe(true);
    expect(text.content).toContain("[connection lost — outcome unknown]");
  });

  test("a dropped count is stated", () => {
    const text = resultText({ ...base, dropped: 999 });
    expect(text.content).toContain("999");
  });
});
