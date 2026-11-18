- **Mobile: the floating hub button animates on the native driver.** Its
  show/hide fade, the rest-opacity fade (30–100 %, solid while touched or with
  the fan open) and the spring after a drag now run on the UI thread, like the
  fan itself and the running-turn arc already did, so a JS thread busy with a
  streaming turn can no longer stutter them. Behaviour is unchanged: tap opens
  the fan, hold-and-slide selects, drag moves it, Reduce Motion still places it
  at once and fades it in.
