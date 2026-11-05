import { PassThrough } from "node:stream";

/**
 * Simulate `script -q /dev/null bun test …` when nobody types: stdin is a TTY
 * that never ends and never sends a key (a PassThrough with the tty.ReadStream
 * extras Ink touches), stdout/stderr report `isTTY`. A test that reads the
 * process's real terminal state (instead of an injected seam) then blocks or
 * misbehaves exactly as on a developer's terminal — in CI too.
 * Returns the restore function (Bun runs files in one process: always call it).
 */
export function simulateSilentTerminal(): () => void {
  const stdinDesc = Object.getOwnPropertyDescriptor(process, "stdin");
  const ttyDescs = (["stdout", "stderr"] as const).map(
    (name) => [name, Object.getOwnPropertyDescriptor(process[name], "isTTY")] as const,
  );
  const silent = new PassThrough() as PassThrough & Record<string, unknown>;
  Object.assign(silent, {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      silent.isRaw = mode;
      return silent;
    },
    ref() {
      return silent;
    },
    unref() {
      return silent;
    },
  });
  Object.defineProperty(process, "stdin", { value: silent, configurable: true });
  for (const [name] of ttyDescs) {
    Object.defineProperty(process[name], "isTTY", {
      value: true,
      configurable: true,
      writable: true,
    });
  }
  return () => {
    silent.destroy();
    if (stdinDesc) {
      Object.defineProperty(process, "stdin", stdinDesc);
    }
    for (const [name, d] of ttyDescs) {
      if (d) {
        Object.defineProperty(process[name], "isTTY", d);
      } else {
        Reflect.deleteProperty(process[name], "isTTY");
      }
    }
  };
}
