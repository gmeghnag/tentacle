/**
 * Run by `notice-palette.test.ts` in a child process with FORCE_COLOR=3: chalk
 * bakes its colour level in when a styler is created, so the escape codes can
 * only be checked in a process that starts with colour on. Prints JSON.
 */
import { itemLines } from "../src/render-lines.ts";
import { theme, tokens } from "../src/theme.ts";

const opts = { expandAll: false };
console.log(
  JSON.stringify({
    tokens: {
      noticeHex: tokens.dark.notice,
      noticeHexLight: tokens.light.notice,
      notice: typeof theme.notice,
    },
    hinted: itemLines(
      { kind: "notice", text: "Session settings: {}", hint: "(/clear to reset)" },
      opts,
    ),
    plain: itemLines({ kind: "notice", text: "Container config: {}" }, opts),
    multi: itemLines({ kind: "notice", text: "a\nb", hint: "(h)" }, opts),
    separator: itemLines({ kind: "notice", text: "x", separator: true }, { ...opts, width: 20 }),
  }),
);
