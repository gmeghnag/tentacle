# feat/mobile-native-sheets — native iOS sheets with three detents

Type: feat · Size: M–L (split if the plan says so) · Blast: cross-module (every sheet in the app) · Suited: Opus plan, DeepSeek exec (one at a time), Opus review, simulator shots

## Context

*— claude-opus-5-5 (orchestrator), 2026-11-23*

Owner 22/11 ~18:50: «native-quality bottom sheets with 3 detents (short/medium/large), perfection in small things». Mockup of the proposal: https://claude.ai/artifact/TX2qs8Rsvk9smZqkDqvGDM (proposal A = native iOS `formSheet` via `react-native-screens` 4.30.1, `sheetAllowedDetents`). Owner 23/11 ~07:30: **A, three-detent sheets — but keep the transitions when tapping workflow tasks** (the agent-workflows node→detail morph + skeleton stays; the alternative «transitions for places you enter» mockup https://claude.ai/artifact/2jyn5wcCgJ1sJyWAjBPPTs is NOT adopted elsewhere).

Today every sheet is RN `<Modal presentationStyle="pageSheet">` (verified 23/11): `apps/mobile/src/screens/ToolsSheet.tsx:130`, `SessionInfoSheet.tsx:369`, `compose/OutboxDecisionSheet.tsx:53`, `CommandsSheet.tsx:294`, `PermissionSheet.tsx:133`. Out of scope: `LockGate.tsx:201` (fullScreen), `ui/diagram/DiagramFullScreen.tsx:63`, `ui/chart/ChartFullScreen.tsx:103` (full screen by design). `react-native-screens` is already a dependency (4.30.1); `react-native-reanimated` is NOT.

Questions the plan must answer from the source: how the app navigates today (is there a native stack at all, or plain RN views + Modals? a `formSheet` needs a screen in a native stack); which detents each sheet gets and which it opens at (e.g. Permission = medium, never dismissible by a stray swipe while an ask is pending; Commands = medium→large; Tools/Info = medium→large; Outbox decision = short); grabber, corner radius, background dimming per detent, keyboard (Rename field) and scroll-to-expand behaviour; Reduce Motion; Dynamic Type; dark/light/petrol; haptics; what the e2e flows (Maestro, `apps/mobile/e2e/flows/`) need to keep finding the same elements; Android is not a target. Owner UI rules: no rounded inset cards, no pure black, thin icons, never meaning by hue alone, an empty entry is dimmed + light haptic + inline label (never an empty sheet).

## Implementation

## Execution

## Review
