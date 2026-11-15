- **A photo sent from the phone now shows its row in the transcript, in order,
  above the reply.** The outbox driver's session port was a second
  `newSession` handle of the same session id, and the client keeps one stream
  listener per id (the newest wins), so opening it took the photo's own turn
  away from the screen: the daemon answered correctly, the transcript never saw
  the row, and the photo appeared after — or instead of — its reply. The port
  is now the screen's own attach handle, so a photo send cannot starve the
  transcript it draws into.
