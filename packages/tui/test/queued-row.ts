/**
 * Matches a QUEUED message's row in an App frame. A queued row looks like a
 * sent one (`› text`), so its place is what tells them apart: queued rows sit
 * just above the input's top rule — followed by the next queued rows, the
 * send-now hint row (indented, no `›`) and, while a turn runs, the
 * thinking/working line (it sits under the queue, right above the input).
 */
export const queuedRow = (text: string): RegExp =>
  new RegExp(
    `› ${text}\\n(?:› [^\\n]*\\n)*(?: {2}[^\\n]*\\n)?(?:\\n?[^\\n]*(?:thinking|working)…[^\\n]*\\n)?─`,
  );
