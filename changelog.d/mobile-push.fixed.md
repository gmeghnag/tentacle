- **Turning notifications off on the phone now stays off, and really stops the
  pushes.** The Notifications switch is the phone's decision and is persisted in
  its own Keychain record, so a relaunch no longer re-registers the phone with
  every computer; turning it off while a computer is not connected leaves a debt
  that the next connection settles before anything else (an unregister that could
  not be sent is never treated as sent); turning it back on registers immediately
  with the computers that are connected instead of waiting for a reconnect; and
  one outdated computer no longer makes the switch inoperable, so notifications
  can still be turned off for the computers that do deliver.
