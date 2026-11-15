- **Answer a permission request from the notification.** On iPhone a push about a
  waiting ask now carries its content end-to-end encrypted and decrypted on the
  phone by a Notification Service Extension (Apple and the relay see only an
  opaque blob): the banner names the computer, the project, the session's title
  and the command's first line, grouped per session. **Approve** always asks Face
  ID (even with the app unlocked) and only ever grants that one request — a
  lasting rule still needs the in-app sheet; **Deny** works straight from the lock
  screen with no prompt, because it grants nothing; **Reply…** takes the phone's
  passcode and sends the words with a refusal; **Open** jumps to the session. If a
  background answer cannot reach the computer within the iOS budget, a "Couldn't
  reach <computer> — tap to answer" notice fires instead, so an answer is never
  silently lost. A notification that cannot be verified against the paired
  computer's key answers nothing at all — the app opens and says so, and the ask
  is still waiting. Turn-finished and turn-failed notices are quiet and grouped
  per session. The extension's own logic is pinned to the same cross-language
  vectors as the phone's (`bun run test:swift`).
