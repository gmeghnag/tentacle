/**
 * Run by `harness-render.test.ts` in a child process with FORCE_COLOR=3: chalk
 * bakes its colour level in when a styler is created, so the escape codes can
 * only be checked in a process that starts with colour on. Prints JSON.
 */
import { itemLines } from "../src/render-lines.ts";
import { theme } from "../src/theme.ts";

const opts = { expandAll: false };
console.log(
  JSON.stringify({
    single: itemLines({ kind: "notice", text: "a job finished" }, opts),
    two: itemLines({ kind: "notice", text: "a\nb" }, opts),
    levels: [
      itemLines({ kind: "notice", text: "it went wrong", level: "warn" }, opts),
      itemLines({ kind: "notice", text: "and then fine" }, opts),
    ].flat(),
    hint: itemLines({ kind: "notice", text: "text", hint: "(/clear)" }, opts),
    separator: itemLines({ kind: "notice", text: "x", separator: true }, { ...opts, width: 20 }),
    harnessStyler: typeof theme.harness,
  }),
);
