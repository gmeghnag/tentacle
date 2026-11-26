# Features

- **Tools:** `fs_read`, `fs_write`, `fs_edit` (with diffs), `shell`, background jobs.
- **Permissions:** shell commands need approval; "always" approvals are scoped to a command prefix.
- **MCP servers**, **sub-agents** (`agent_task`, custom types in `<configDir>/agents/*.md`) and **Agent Skills** (`SKILL.md` in `.agents/skills/`, `<configDir>/skills/` or `~/.agents/skills/`; `/skill-name` in the TUI). See [`docs/architecture/skills.md`](../architecture/skills.md).
- **TUI:** diffs, mouse scroll and selection, slash commands, `/compact`, saved sessions; `/help` lists the rest.
- **Voice dictation (macOS, off by default):** turn it on with `voice.enabled: true` in the config, then press **Ctrl+R** in the TUI, speak, press it again — the text lands in the input field for you to edit and send. Speech is recognised on the Mac (Apple's built-in on-device recogniser by default), so no audio leaves the machine or is written to disk; nothing is sent until you press Enter. Esc throws the dictation away without touching a running turn. See [Voice dictation](#voice-dictation) below.

## Voice dictation

Local TUI on a Mac, with a real microphone. **Off by default:** set
`voice.enabled: true` in the config file to turn it on (while off, Ctrl+R says
so instead of opening the mic). Not available over SSH or in a container —
Ctrl+R then says so instead of capturing the wrong machine.

| While dictating | Key | Effect |
|---|---|---|
| idle | **Ctrl+R** | start listening |
| listening | **Ctrl+R** or **Enter** | transcribe and insert. Enter here never sends |
| listening or transcribing | **Esc** | discard; a running agent turn is untouched |

```sh
bun run voice:build          # from source only (the installer ships it): → dist/tentacle-voice
tentacle voice status        # recogniser, installed languages, mic permission
tentacle voice setup         # install Apple's speech asset for a missing language
```

The first Ctrl+R makes macOS ask for the microphone, naming your terminal app;
denying it is reported (`Microphone blocked for …`, with the System Settings
path), never a silent no-op. Settings live under `voice` in the config file:
`key` (rebindable), `language` (`auto` follows the Mac's language, or force
`it`/`en`), `autoStop` (off by default — you end the dictation with the key, so
a pause after a comma can never cut you off), `maxSeconds`, `input`
(`builtin` avoids the AirPods call-profile downgrade) and `enabled` (off by
default). `tentacle voice status` prints whether voice is enabled and how to
turn it on. `bun run voice:test` runs
the helper's own tests; it is a separate step because the gate must stay green on
Linux CI.

