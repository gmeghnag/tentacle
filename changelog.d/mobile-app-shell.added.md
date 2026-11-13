- **Mobile app shell and the `e2e:mobile` harness.** The Expo app now has a
  native-stack shell (Computers → Sessions → a session placeholder) that lists a
  computer's sessions over the existing RPC stack, with Active/Archived
  sections, running/attached/job badges and honest link-failure wording, plus
  `bun run e2e:mobile`: a real `serve`, a mock model and Maestro flows on the
  iOS simulator — the gate every later mobile task merges through.
