# Public-Ready Signoff

Use this checklist before the first public push or any release-style handoff of the repo.

Release posture: experimental public launch for Codex Desktop users.

## Required Signoff

- privacy review complete
- security review complete
- log redaction verified in recent daemon and gateway logs
- README and docs aligned with the actual runtime behavior
- `bridge:capabilities` still reports base readiness, provider readiness, live-call readiness, and terminal-lane gates without exposing secrets or terminal scrollback
- `npm run check` passed
- `npm run check:security` passed
- `npm run smoke:local -- --env-file /path/to/.env --config-file /path/to/bridge.config.toml` passed when borrowing an existing local bot setup
- one maintenance-window live smoke completed against the current bot if `/call` is being advertised
- `npm run clean:local-state` reviewed, then rerun with `-- --apply` if this workspace should be scrubbed before push

## Manual Final Review

- base bridge still works first; `/call` remains clearly documented as experimental
- `shadow-window` is still clearly labeled experimental, macOS-only, and non-core
- the terminal lane is still clearly labeled experimental, disabled by default, gated before workspace-write or user-owned sessions, and explicit via `/terminal`
- exact chat ids only appear in `telegram:discover` or explicit setup flows, while private-chat labels and raw webhook URLs stay out of the default setup path
- daemon and gateway status output remain useful without exposing raw Telegram text, usernames, prompts, client IPs, launch tokens, or control secrets
- no private branding, private usernames, private paths, or private provider references remain in tracked files

## Release Notes Guidance

- describe the repo as a local app plus CLI for Codex Desktop users
- lead with the base Telegram bridge path
- mention `/call` only as an experimental OpenAI Realtime-backed path
- mention the terminal lane only as an experimental explicit terminal surface, with safe tmux first
- avoid describing the gateway routes as a stable external API
