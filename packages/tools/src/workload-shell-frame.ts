/**
 * The PURE half of `workload_shell` (docs/feat/workload-shell.md D2): the
 * bootstrap and command lines, the incremental sentinel scanner, the bounded
 * capture window, the kill script and the result text. No I/O, no React — every
 * rule here is a function, so a bug in the wire format is understood and tested
 * in one place instead of being chased through a component or a fake.
 *
 * **Why a sentinel at all.** A non-TTY `sh` gives one byte stream, no exit code
 * and no notion of "this command finished". We delimit each command with a
 * random 128-bit marker that also carries `$?` and `$PWD`, so a call's result is
 * (output, exit code, cwd) — and `cd`/`export` can persist between calls because
 * the command runs in the shell itself, not in a subshell.
 *
 * **What comes back is DATA.** A hostile pod can forge a marker, an exit code or
 * a cwd (§4 "a pod is not trusted"). Nothing parsed here is used for anything
 * but the text shown to the model: no laptop path, no permission, no decision.
 */
import { randomBytes } from "node:crypto";

/** Bytes of nonce per command (and for the ready marker). 128 bits, hex-encoded. */
export const NONCE_BYTES = 16;

/** The marker's fixed shape: `__TNT_<nonce>_B_<code>_<cwd>__TNT_<nonce>_E`. */
const MARKER = "__TNT_";

/**
 * The bootstrap marker's nonce. Constant, because the bootstrap line must be
 * CONSTANT apart from nothing at all (§4 pin: no env expansion, nothing the
 * daemon knows may leak into the pod) — and a fixed `R` kind cannot collide with
 * a command's `B`…`E` pair.
 */
export const BOOTSTRAP_NONCE = "";
/** `__TNT__R_<pid>_<cwd>__TNT__E` — the ready marker's own prefix (fixed, not a nonce). */
export const READY_PREFIX = `${MARKER}_R_`;

/** Capture window: this much head plus this much tail, and a count of what fell between. */
export const OUTPUT_HEAD_BYTES = 32 * 1024;
export const OUTPUT_TAIL_BYTES = 32 * 1024;

/** A fresh 128-bit nonce, hex. */
export function makeNonce(): string {
  return randomBytes(NONCE_BYTES).toString("hex");
}

/**
 * Escape a command for a single-quoted POSIX shell string. This is purely
 * lexical — no parsing, no interpretation — so it needs nothing in the image
 * (`base64` is not guaranteed). `'` → `'\''` is the only substitution that
 * matters: everything else inside single quotes is already literal.
 */
export function escapeSingleQuoted(command: string): string {
  return command.replaceAll("'", "'\\''");
}

/**
 * The single line that starts the shell and reports its pid + initial cwd.
 * Everything in it is shell-side (`$$`, `$PWD`); nothing is interpolated by the
 * daemon, so no laptop value can reach the pod through it.
 */
export function bootstrapLine(nonce: string): string {
  return `printf '${MARKER}%s_R_%s_%s${MARKER}%s_E\\n' '${nonce}' "$$" "$PWD" '${nonce}'\n`;
}

/**
 * One command, framed. The pieces, each load-bearing:
 *
 * - `command eval '<C>'` — `command` makes the builtin's errors non-fatal: in a
 *   non-interactive POSIX shell a special-builtin error (a syntax error, `set -e`)
 *   would otherwise kill the shell. **Verified** on busybox ash, dash and bash
 *   (Execution, step 0).
 * - `</dev/null` — a command that reads stdin (`cat`, `ssh`, a `y/N` prompt)
 *   gets EOF at once instead of swallowing the commands we write after it.
 * - `2>&1` — one interleaved stream in arrival order; the shell's own stderr
 *   (channel 2) stays for diagnostics only.
 * - the trailing `printf` reports `$?` and `$PWD` between two markers, so a cwd
 *   containing `_`, `__` or a newline still parses (the begin/end pair delimits).
 */
export function commandLine(command: string, nonce: string): string {
  const body = escapeSingleQuoted(command);
  return `command eval '${body}' </dev/null 2>&1; printf '\\n${MARKER}%s_B_%d_%s${MARKER}%s_E\\n' '${nonce}' "$?" "$PWD" '${nonce}'\n`;
}

/** The marker text a command's end is scanned for (both halves). */
function beginMarker(nonce: string): Uint8Array {
  return new TextEncoder().encode(`\n${MARKER}${nonce}_B_`);
}

function endMarker(nonce: string): Uint8Array {
  return new TextEncoder().encode(`${MARKER}${nonce}_E`);
}

/** The ready marker's own begin/end pair (the bootstrap's fixed nonce). */
function readyBegin(): Uint8Array {
  return new TextEncoder().encode(READY_PREFIX);
}

function readyEnd(): Uint8Array {
  return new TextEncoder().encode(`${MARKER}${BOOTSTRAP_NONCE}_E`);
}

/** Find `needle` in `haystack` (a plain byte search — never on decoded text). */
function indexOfBytes(haystack: Uint8Array, needle: Uint8Array, from = 0): number {
  const last = haystack.length - needle.length;
  const first = needle[0] as number;
  for (let i = from; i <= last; i++) {
    if (haystack[i] !== first) {
      continue;
    }
    let hit = true;
    for (let j = 1; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) {
        hit = false;
        break;
      }
    }
    if (hit) {
      return i;
    }
  }
  return -1;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** The bootstrap's answer: the shell's pid and initial cwd. */
export interface ReadySeen {
  readonly kind: "ready";
  readonly pid: number;
  readonly cwd: string;
}

const decoder = new TextDecoder();

/**
 * Parse the ready marker out of `text` (`__TNT__R_<pid>_<cwd>__TNT__E`). `pid`
 * must be a positive integer — a marker whose pid is not one is not ours, so it
 * is treated as output and the caller waits for the real one.
 */
export function parseReady(text: string, _offset = 0): ReadySeen | null {
  // From the FIRST prefix: the marker's own end is `__TNT__E`, so scanning from
  // the last occurrence would pick up an unrelated trailing string.
  const start = text.indexOf(READY_PREFIX);
  if (start === -1) {
    return null;
  }
  const end = text.indexOf(`${MARKER}${BOOTSTRAP_NONCE}_E`, start);
  if (end === -1) {
    return null;
  }
  const payload = text.slice(start + READY_PREFIX.length, end);
  const cut = payload.indexOf("_");
  if (cut <= 0) {
    return null;
  }
  const pidText = payload.slice(0, cut);
  if (!/^[0-9]+$/.test(pidText)) {
    return null;
  }
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    return null;
  }
  return { kind: "ready", pid, cwd: payload.slice(cut + 1) };
}

/** What a command's stream produced. `bytes` is output as it arrived (bounded by the window). */
export type FrameEvent =
  | { readonly kind: "output"; readonly bytes: Uint8Array }
  | { readonly kind: "done"; readonly code: number; readonly cwd: string };

/** An incremental byte scanner. `push` it chunks; it emits output then done. */
export interface FrameParser {
  push(bytes: Uint8Array): void;
  /**
   * The stream ended (or the caller stopped waiting): emit whatever the marker
   * carry is still holding, as output. Idempotent, and a no-op after `done`.
   */
  flush(): void;
}

/**
 * The bounded capture window: a head, a tail and the count of what fell between.
 * Memory stays bounded however chatty the command is — a command printing
 * gigabytes costs the same as one printing 64 KiB.
 *
 * It is also the parser's sink, so the two cannot disagree about what "the
 * output" was: `text()` is exactly what the parser saw.
 */
export class CaptureWindow {
  private head: Uint8Array = new Uint8Array(0);
  private tail: Uint8Array = new Uint8Array(0);
  private droppedBytes = 0;
  private totalBytes = 0;
  private sawNul = false;
  private replacements = 0;
  private chars = 0;

  /** Bytes the window was given (all of them, before capping). */
  get total(): number {
    return this.totalBytes;
  }

  /** Bytes omitted between the head and the tail. */
  get dropped(): number {
    return this.droppedBytes;
  }

  /** A parser whose `output` events land in this window. */
  parser(nonce: string, onEvent: (event: FrameEvent) => void): FrameParser {
    const begin = beginMarker(nonce);
    const end = endMarker(nonce);
    // A marker can straddle a chunk boundary, so in the OUTPUT phase hold back
    // `begin.length - 1` bytes — the longest suffix that could still become one.
    const carryBytes = begin.length - 1;
    let buffer = new Uint8Array(0);
    // Two explicit phases: everything is output until the begin marker, then
    // everything is the marker's payload until the end marker. Re-scanning for
    // the begin marker in the payload phase would lose a `done` whenever the
    // payload and the end marker arrive in different chunks.
    let phase: "output" | "payload" | "done" = "output";

    const emitOutput = (bytes: Uint8Array): void => {
      if (bytes.length === 0) {
        return;
      }
      this.push(bytes);
      onEvent({ kind: "output", bytes });
    };

    return {
      push: (chunk: Uint8Array): void => {
        if (phase === "done") {
          return;
        }
        buffer = concat(buffer, chunk);
        // One pass per chunk: a single chunk may carry output, the begin marker
        // AND the payload + end marker (the common case).
        for (;;) {
          if (phase === "output") {
            const at = indexOfBytes(buffer, begin);
            if (at === -1) {
              const keep = Math.min(carryBytes, buffer.length);
              emitOutput(buffer.subarray(0, buffer.length - keep));
              buffer = buffer.subarray(buffer.length - keep).slice();
              return;
            }
            emitOutput(buffer.subarray(0, at));
            buffer = buffer.subarray(at + begin.length).slice();
            phase = "payload";
            continue;
          }
          if (phase === "payload") {
            const endAt = indexOfBytes(buffer, end);
            if (endAt === -1) {
              return; // wait for the rest of the payload / the end marker
            }
            const payload = decoder.decode(buffer.subarray(0, endAt));
            buffer = buffer.subarray(endAt + end.length).slice();
            const cut = payload.indexOf("_");
            const codeText = cut === -1 ? payload : payload.slice(0, cut);
            const cwd = cut === -1 ? "" : payload.slice(cut + 1);
            phase = "done";
            onEvent({
              kind: "done",
              code: /^-?[0-9]+$/.test(codeText) ? Number(codeText) : 1,
              cwd,
            });
            return;
          }
        }
      },
      flush: (): void => {
        if (phase === "done") {
          return;
        }
        const held = buffer;
        buffer = new Uint8Array(0);
        if (phase === "output") {
          emitOutput(held);
        }
        // In the payload phase the stream died mid-marker: the caller reports
        // "no done" (an end/connection notice), so nothing is emitted, but the
        // bytes are not lost either — they are not a result, they are garbage.
        phase = "done";
      },
    };
  }

  /** Append raw bytes to the window (head, then tail, dropping the middle). */
  push(bytes: Uint8Array): void {
    this.totalBytes += bytes.length;
    if (bytes.includes(0)) {
      this.sawNul = true;
    }
    const text = decoder.decode(bytes);
    this.chars += text.length;
    this.replacements += (text.match(/\uFFFD/g) ?? []).length;

    // Fill the head first, then the tail, evicting the head of the tail.
    const headRoom = OUTPUT_HEAD_BYTES - this.head.length;
    if (headRoom > 0) {
      const take = Math.min(headRoom, bytes.length);
      this.head = concat(this.head, bytes.subarray(0, take));
      const rest = bytes.subarray(take);
      if (rest.length > 0) {
        this.pushTail(rest);
      }
      return;
    }
    this.pushTail(bytes);
  }

  private pushTail(bytes: Uint8Array): void {
    const combined = concat(this.tail, bytes);
    if (combined.length <= OUTPUT_TAIL_BYTES) {
      this.tail = combined;
      return;
    }
    const overflow = combined.length - OUTPUT_TAIL_BYTES;
    this.droppedBytes += overflow;
    this.tail = combined.subarray(overflow).slice();
  }

  /** True when the output looks binary: a NUL, or more than 10 % U+FFFD. */
  binary(): boolean {
    if (this.sawNul) {
      return true;
    }
    return this.chars > 0 && this.replacements / this.chars > 0.1;
  }

  /** The body as text: the whole output, or head + a banner + tail. */
  text(): string {
    if (this.binary()) {
      return `[binary output: ${this.totalBytes} bytes not shown — pipe through \`od -c | head\` or \`base64\` if you need it]`;
    }
    return formatBody(decoder.decode(this.head), decoder.decode(this.tail), this.droppedBytes);
  }
}

/** `head`, a banner naming what fell between, then `tail`. */
export function formatBody(head: string, tail: string, dropped: number): string {
  if (dropped === 0 || tail === "") {
    return head + tail;
  }
  return `${head}\n[${dropped} bytes omitted from the middle]\n${tail}`;
}

/** Remove exactly ONE leading `\n` (the one our `printf` adds), not the command's own. */
export function stripLeadingNewline(bytes: Uint8Array): Uint8Array {
  if (bytes.length > 0 && bytes[0] === 0x0a) {
    return bytes.subarray(1);
  }
  return bytes;
}

/** Split output into lines, keeping blank ones (the Ink `Text` rule is a render concern). */
export function separateLines(text: string): string[] {
  if (text === "") {
    return [];
  }
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

/**
 * A POSIX-sh script that kills every DESCENDANT of `pid` (recursively) with
 * `signal`, and optionally `pid` itself.
 *
 * It reads the ppid from each process's `/proc/<pid>/stat`, field 4 — *after the
 * last `)`*, because the process's own name (`comm`) may contain spaces or
 * parens. That is deliberate: `pkill -P` is not in every image (busybox has no
 * `pkill` unless built with it) and `pgrep` may be absent entirely, while `/proc`
 * is mounted in every Linux container. Descendants are found by walking each
 * candidate's ppid chain up to the shell, which needs no frontier bookkeeping.
 *
 * The pids it killed are printed, so the daemon log names them.
 */
export function killTreeScript(
  pid: number,
  signal: string,
  options?: { includeSelf?: boolean },
): string {
  const self = options?.includeSelf === true ? "1" : "0";
  return [
    `# workload_shell: kill the descendants of ${pid} (signal ${signal})`,
    `__tnt_target=${pid}`,
    `__tnt_self=${self}`,
    "__tnt_pairs=",
    "for __tnt_d in /proc/[0-9]*; do",
    "  __tnt_p=${__tnt_d#/proc/}",
    '  [ -r "/proc/$__tnt_p/stat" ] || continue',
    "  __tnt_rest=$(sed 's/^[0-9]* (.*) //' \"/proc/$__tnt_p/stat\" 2>/dev/null) || continue",
    '  __tnt_ppid=$(echo "$__tnt_rest" | cut -d" " -f2)',
    '  [ -n "$__tnt_ppid" ] && __tnt_pairs="$__tnt_pairs $__tnt_p:$__tnt_ppid"',
    "done",
    "for __tnt_pair in $__tnt_pairs; do",
    "  __tnt_p=${__tnt_pair%%:*}",
    "  __tnt_pp=${__tnt_pair##*:}",
    "  # NEVER kill ourselves: when this script runs under the shell it is",
    "  # itself a descendant of the target, and dying mid-walk would leave the",
    "  # rest of the tree alive.",
    '  [ "$__tnt_p" = "$$" ] && continue',
    "  # Walk this process's ancestry: a hit on the shell makes it a victim.",
    "  __tnt_hop=0",
    '  while [ -n "$__tnt_pp" ] && [ "$__tnt_pp" != "0" ] && [ "$__tnt_hop" -lt 64 ]; do',
    '    if [ "$__tnt_pp" = "$__tnt_target" ]; then',
    `      kill -${signal} "$__tnt_p" 2>/dev/null && echo "killed $__tnt_p (-${signal})"`,
    "      break",
    "    fi",
    '    __tnt_next=""; __tnt_seen=0',
    "    for __tnt_q in $__tnt_pairs; do",
    '      if [ "${__tnt_q%%:*}" = "$__tnt_pp" ]; then',
    "        __tnt_next=${__tnt_q##*:}; __tnt_seen=1; break",
    "      fi",
    "    done",
    '    [ "$__tnt_seen" = "1" ] || break',
    "    __tnt_pp=$__tnt_next",
    "    __tnt_hop=$((__tnt_hop + 1))",
    "  done",
    "done",
    'if [ "$__tnt_self" = "1" ]; then',
    `  kill -${signal} "$__tnt_target" 2>/dev/null && echo "killed $__tnt_target (-${signal})"`,
    "fi",
    "exit 0",
    "",
  ].join("\n");
}

/** One line of a run's result, appended after the body (see `resultText`). */
export type WorkloadShellNotice = string;

export interface ResultTextInput {
  readonly exitCode: number;
  readonly cwd: string;
  /** `kubernetes default/api-0` | `docker box`. */
  readonly target: string;
  readonly seconds: number;
  readonly body: string;
  readonly dropped: number;
  /** `[shell stderr]` diagnostics, when the shell itself said something. */
  readonly shellStderr?: string;
  readonly notices: readonly WorkloadShellNotice[];
}

/**
 * The model-facing result: a header (`exit=` first, the `shellTool` convention),
 * the body, then one line per notice.
 *
 * It is an ERROR when the exit code is non-zero OR any notice applies: a notice
 * always means the shell's state (cwd/env) is gone or the outcome is unknown, and
 * a model that reads "exit=0" alone would trust a state that no longer exists.
 */
export function resultText(input: ResultTextInput): { content: string; isError: boolean } {
  const seconds =
    input.seconds < 10 ? input.seconds.toFixed(1) : Math.round(input.seconds).toString();
  const lines = [`exit=${input.exitCode} · cwd=${input.cwd} · ${input.target} · ${seconds}s`];
  if (input.body !== "") {
    lines.push(input.body);
  }
  if (input.shellStderr !== undefined && input.shellStderr !== "") {
    lines.push(`[shell stderr] ${input.shellStderr}`);
  }
  if (input.dropped > 0) {
    lines.push(`[${input.dropped} bytes omitted from the middle]`);
  }
  for (const notice of input.notices) {
    lines.push(notice);
  }
  return {
    content: lines.join("\n"),
    isError: input.exitCode !== 0 || input.notices.length > 0,
  };
}
