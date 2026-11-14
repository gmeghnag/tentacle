- **The input's image attachments moved out of `App.tsx` into one hook.** The
  paste/`/attach`/drop decisions and the upload loop now live in
  `packages/tui/src/useAttachments.ts`, which owns the one-decision-at-a-time
  chain the feature needs; the draft state and the unmount abort stay in `App` so
  the render, `submit`, Backspace and Esc keep their identifiers. No user-visible
  behaviour changes.
