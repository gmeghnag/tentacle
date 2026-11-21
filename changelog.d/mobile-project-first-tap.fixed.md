- **A just-paired project no longer reads "Not reachable", and its first tap opens it.** A row whose
  status probe has not answered yet has its own `Checking…` state instead of being projected as a
  computer that does not answer, and a tap on a waiting (or stopped / not reachable) row now waits
  for that probe — up to 4 s — then opens the project if it answers, instead of silently re-probing
  (`apps/mobile/src/project-rows.ts`, `apps/mobile/App.tsx`). A tap that lands after you have moved on
  (another row, the menu, Add, a Pair, Remove, or leaving the screen or the app) no longer opens
  anything later.
