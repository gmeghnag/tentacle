# Known upstream library bugs

Bugs we have hit in third-party libraries we depend on, the version we are on,
the version that fixes them, and how we work around them meanwhile. Keep this
current: when we bump a dependency past a "fixed in" line here, drop the
workaround and the entry (or move it to a "resolved" note).

Each entry must be **reproduced**, not assumed: cite the minimal repro and the
versions actually tested (not just release notes).

---

## Ink — nested `<Text inverse>` mis-measures across re-renders (block cursor bleed)

- **Library:** `ink`
- **Version in use:** `5.0.1` (peer `react@18.3.1`)
- **Affected:** all of `5.0.0`–`5.2.1`, and `6.0.0`–`6.5.0` (tested)
- **Fixed in:** `~6.6.0` (confirmed broken on `6.5.0`, fixed on `6.8.0` and
  `8.0.0`). **Every fixed version requires `react@>=19`** (`ink@6` peer is
  `react>=19.0.0`), so adopting the fix means an Ink 5→6+ **and** React 18→19
  migration.

### Symptom

A `<Text>` whose children are a string + a nested `<Text inverse>` + a string
(the classic block-cursor row) mis-measures its width when, across re-renders,
the content grows by a character while the cursor is mid-line. Yoga appears to
cache the earlier (shorter) width, so the last character wraps onto the next
row. In the TUI input box this pushed the final char onto the bordered box's
rule row, e.g. the value `Xhello` rendered as:

```
❯ Xhell
──o─────────────────────────────────────────…
```

### Repro (isolated, no app state)

Render through a re-render sequence that grows the value with the cursor
mid-line, inside a bordered box, with the cursor as a nested inverse Text:

```tsx
// steps: "h"(1) "he"(2) … "hello"(5) → "hello"(cursor 0) → "Xhello"(cursor 1)
<Box width={100} borderStyle="round" borderLeft={false} borderRight={false}>
  <Text>❯ </Text>
  <Text>{v.slice(0, c)}<Text inverse>{v[c] ?? " "}</Text>{v.slice(c + 1)}</Text>
</Box>
```

On `ink@5.0.1`–`6.5.0` the last char wraps onto the border row
(`❯ Xhell` + `──o──`); on `ink@6.8.0`/`8.0.0` it renders `❯ Xhello` cleanly.
Same code, only the Ink version changed.

### Our workaround (no upgrade)

Render the block cursor as **sibling** `<Text>` nodes in the row Box instead of
nesting an inverse `<Text>` inside the content `<Text>`:

```tsx
<Box>
  <Text color={prefixColor}>{prefix}</Text>
  {before === "" ? null : <Text>{before}</Text>}
  <Text inverse>{line[col] ?? " "}</Text>
  {after === "" ? null : <Text>{after}</Text>}
</Box>
```

Siblings in a row measure correctly and render contiguously. Keeps Ink's native
`inverse` (works even when colour is disabled, unlike a `chalk.inverse` string).

- **Code:** `packages/tui/src/components/LineInput.tsx` (cursor row).
- **Regression test:** `packages/tui/test/app.test.tsx` →
  "a mid-line cursor reached by editing renders on one clean line" (asserts no
  char bleeds onto the border row).

### Related

- Ink 5.0.1 also does **not** surface Home/End through `useInput` (they arrive
  as `input=""` with no flag, because `parse-keypress` maps them into
  `nonAlphanumericKeys` which `use-input` blanks). `key.home`/`key.end` land in
  `ink@8` (`use-input.js`), again gated behind React 19. We bind line start/end
  to **Ctrl+A / Ctrl+E** (readline convention) instead — see
  `docs/feat/tui-input-editing.md`.
- **Known Ink gotcha (not a bug):** an empty `<Text>` measures `0×0`, so a
  per-row `<Text>` list collapses blank rows. Render blank rows as `" "`. (In
  AGENTS.md §6.)

---

## Bun test — `expect(p).rejects` spins forever on a promise that never settles

- **Library:** `bun` (test runner, `bun:test`)
- **Version in use:** `1.4.3` (`c6da4a4d3`), macOS arm64 (tested)
- **Affected:** `1.4.3` (only version tested)
- **Fixed in:** unknown

### Symptom

`await expect(p).rejects.toBe(…)` (any matcher) where `p` never settles does
not time out: the process pins a core (~100% user CPU) and `--timeout` is not
enforced, so the whole `bun test` run hangs. A plain `await new Promise(() =>
{})` in a test times out normally. Inside a larger file it can also surface as
"this test timed out", after which the NEXT test hangs the run.

Hit in `fix/daemon-compact-turn-guard`: on the buggy code a request the test
expects to be rejected is instead left parked — exactly the regression the test
exists to catch, which then hung the suite instead of failing it.

### Repro (isolated)

```ts
import { expect, test } from "bun:test";
const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));
test("parks forever", async () => {
  await expect(new Promise(() => {})).rejects.toBe(1);
});
test("after a timeout, timers still fire", async () => {
  for (let i = 0; i < 3; i++) await tick();
  expect(1).toBe(1);
});
```

`perl -e 'alarm 8; exec @ARGV' bun test --timeout 500 ./bun-timeout.test.ts`
→ killed by the alarm (`exit=142`, `real 8.03`, `user 7.96`), no test result
printed — deterministic over 2 runs (2026-10-20). Replacing the first test body
with `await new Promise(() => {})` → `(fail) parks forever [500.01ms]`,
`1 pass, 1 fail`.

### Our workaround (no upgrade)

For a promise that may stay pending on a regression, don't use `.rejects`:
race it against a short timer and assert on the outcome — the `rejection(p,
ms)` helper in `packages/daemon/test/integration.test.ts` ("compaction is
exclusive with a turn"). Existing `.rejects` on promises that always settle
are unaffected.
