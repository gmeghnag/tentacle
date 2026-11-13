/**
 * The React-19 type pin's guard (docs/feat/mobile-app-shell.md "Tests"): the
 * app is on React 19 (the TUI stays on 18), and `apps/mobile/tsconfig.json`'s
 * `paths` entry pins `react` to the app's own `@types/react` 19 — a pin the gate
 * does NOT otherwise protect (the spike's carry-over, mobile-spike.md).
 *
 * `useActionState` exists only in React 19's types (the root `@types/react` 18
 * does not declare it). So: remove the `paths` pin and `tsc -p apps/mobile`
 * fails HERE, naming it — which is the alarm. If this file stops typechecking,
 * the pin is gone: restore it, do not "fix" this file.
 */
import { useActionState } from "react";

/** React 19's action-state hook, pinned by type identity (never called). */
export const guardedUseActionState: typeof useActionState = useActionState;

export const reactMajor = 19 as const;
