/**
 * Best-effort clipboard read/write across platforms (pbcopy/pbpaste, wl-copy/
 * wl-paste, xclip, xsel, clip/PowerShell). Rejects if no clipboard tool is
 * available; callers surface that gracefully.
 */
function writeCandidates(): string[][] {
  if (process.platform === "darwin") {
    return [["pbcopy"]];
  }
  if (process.platform === "win32") {
    return [["clip"]];
  }
  return [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]];
}

function readCandidates(): string[][] {
  if (process.platform === "darwin") {
    return [["pbpaste"]];
  }
  if (process.platform === "win32") {
    return [["powershell", "-NoProfile", "-Command", "Get-Clipboard"]];
  }
  return [
    ["wl-paste"],
    ["xclip", "-selection", "clipboard", "-o"],
    ["xsel", "--clipboard", "--output"],
  ];
}

export async function copyToClipboard(text: string): Promise<void> {
  const errors: string[] = [];
  for (const cmd of writeCandidates()) {
    try {
      const proc = Bun.spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
      proc.stdin.write(text);
      await proc.stdin.end();
      const code = await proc.exited;
      if (code === 0) {
        return;
      }
      errors.push(`${cmd[0]} exited ${code}`);
    } catch (error) {
      errors.push(`${cmd[0]}: ${String(error)}`);
    }
  }
  throw new Error(`no clipboard tool available (${errors.join("; ")})`);
}

/** Read the OS clipboard. Rejects if no clipboard tool is available. */
export async function readClipboard(): Promise<string> {
  const errors: string[] = [];
  for (const cmd of readCandidates()) {
    try {
      const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
      const out = await new Response(proc.stdout).text();
      const code = await proc.exited;
      if (code === 0) {
        return out;
      }
      errors.push(`${cmd[0]} exited ${code}`);
    } catch (error) {
      errors.push(`${cmd[0]}: ${String(error)}`);
    }
  }
  throw new Error(`no clipboard tool available (${errors.join("; ")})`);
}
