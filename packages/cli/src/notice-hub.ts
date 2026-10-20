/**
 * The host side of the TUI's `NoticeFeed`: anything on the main thread that
 * must tell the user something while Ink owns the terminal (a failed session
 * save, a skipped resume file) calls `notify` instead of writing to stdout
 * (AGENTS §7). Notices sent before the TUI subscribes are buffered and
 * delivered on the first subscription, so a pre-mount warning is not lost
 * behind the alternate screen.
 */
import type { NoticeFeed } from "@tentacle/tui";

export class NoticeHub implements NoticeFeed {
  private readonly listeners = new Set<(text: string) => void>();
  private buffered: string[] = [];

  notify(text: string): void {
    if (this.listeners.size === 0) {
      this.buffered.push(text);
      return;
    }
    for (const listener of this.listeners) {
      listener(text);
    }
  }

  onNotice(listener: (text: string) => void): () => void {
    this.listeners.add(listener);
    const pending = this.buffered;
    this.buffered = [];
    for (const text of pending) {
      listener(text);
    }
    return () => {
      this.listeners.delete(listener);
    };
  }
}
