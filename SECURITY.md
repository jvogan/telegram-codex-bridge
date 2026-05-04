# Security Policy

## Scope

This project handles Telegram bot credentials, model-provider API keys, Telegram message content, locally staged files, and live-call artifacts. Treat configuration, local state, and generated artifacts as sensitive.

## Trust Boundaries

The bridge spans four trust zones:

- the local machine running Codex Desktop and the bridge daemons
- Telegram as the user-facing chat transport
- provider APIs such as OpenAI, ElevenLabs, and Google
- the optional public Mini App origin used for live `/call`
- optional local terminal sessions when the terminal lane is explicitly enabled

The bridge is designed as a local-first operator tool. It is not a hosted multi-tenant service, and it assumes the operator controls the local machine and the bot configuration.

## Secrets And Configuration

Secrets belong in `.env` or `.env.local`, never in tracked files.

Sensitive values include:

- `TELEGRAM_BOT_TOKEN`
- `OPENAI_API_KEY`
- `ELEVENLABS_API_KEY`
- `GOOGLE_GENAI_API_KEY`
- `REALTIME_CONTROL_SECRET`

Do not commit `.env`, `.env.local`, `bridge.config.toml`, `.bridge-data`, `dist`, or `node_modules`.

## Local Data Handling

Runtime state is stored under `.bridge-data` by default. That local state can include:

- queued Telegram task metadata
- staged inbound files
- extracted text derived from PDFs and other documents
- generated artifact metadata and delivery records
- live-call event logs, summaries, and final handoff artifacts

If local disk exposure is a concern, treat `.bridge-data` as sensitive application data and secure the host accordingly.

## Log Redaction Policy

General daemon and gateway logs are redacted by default.

Normal logs should not contain:

- raw Telegram message text
- raw `/image` prompts
- Telegram usernames or first names
- full Telegram chat ids or Telegram user ids
- client IPs
- raw Telegram Mini App init-data
- launch tokens, client tokens, ephemeral keys, or control secrets
- raw Codex app-server stdout/stderr payloads

Operational diagnostics stay metadata-first instead:

- call ids, queue ids, task ids, stage labels, timestamps, ages, and blocker labels
- redacted or truncated identifiers where correlation still matters
- recent call bundle locations under `.bridge-data`

Exact chat ids remain intentionally available in `telegram:discover`, because setup requires the operator to copy the authorized id into config.

## Live Call Surface Protections

The `/call` surface is protected by several layers:

- Telegram Mini App init-data verification tied to the bot token
- short-lived launch tokens
- per-IP, per-bridge, per-user, and per-token rate limits
- gateway health checks before the Mini App is considered ready
- a local bridge control secret for operator hangup/control paths
- call duration and daily budget caps in `bridge.config.toml`

The gateway HTTP routes and websocket route are internal implementation details, not a stable public API contract.

## Optional Terminal Lane Protections

The terminal lane is experimental and disabled by default.

Public-safe defaults and gates:

- bridge-owned `tmux` first
- `read-only` sandbox and `never` approvals
- no silent Telegram-to-terminal chat route; `/terminal chat on` is explicit and keeps native media, web-search, live-call, and desktop-control requests on the primary bridge path
- no raw terminal scrollback persistence in bridge state
- user-owned iTerm2, Terminal.app, or existing tmux panes require `terminal_lane.allow_user_owned_sessions = true`
- interrupt and clear controls require `terminal_lane.allow_terminal_control = true`
- write-capable tmux requires `terminal_lane.profile = "power-user"`, `terminal_lane.sandbox = "workspace-write"`, and `terminal_lane.approval_policy = "on-request"`

`npm run bridge:capabilities` reports terminal-lane gates without inspecting scrollback. Use `npm run bridge:ctl -- terminal status` only when live terminal discovery is needed.

## Security Verification

Run these before a public push:

- `npm run check`
- `npm run check:security`
- `npm run clean:local-state`

`npm run check:security` currently covers:

- production dependency audit via `npm audit --omit=dev`
- public repo audit for private strings, local residue, and unreviewed binary assets
- tracked-file secret scanning with a repo allowlist for documented placeholders

## Deployment Recommendations

- Prefer the default managed quick tunnel during local development unless you already operate a stable public origin.
- If you expose a static public origin, terminate TLS correctly and keep the origin limited to the realtime Mini App surface.
- Restrict who can interact with the Telegram bot by setting `telegram.authorized_chat_id`.
- Keep the host patched and avoid running the bridge on shared or multi-user machines without additional operating-system hardening.
- Rotate secrets immediately if they are exposed in logs, screenshots, shell history, or git history.

## Reporting

Please do not publish credential leaks, privilege-escalation paths, or working exploit details in a public issue.

Use the repository host's private security reporting flow if it is available. If it is not available, open a minimal issue requesting a private contact path without including secrets or exploit steps.

## Maintainer Expectations

- rotate exposed credentials immediately
- remove leaked secrets from git history before public release
- keep `.env`, `.env.local`, `bridge.config.toml`, `.bridge-data`, `dist`, and `node_modules` out of version control
- keep provider integrations limited to the documented public surface
- keep user-facing product strings configurable through `bridge.config.toml`
- keep `shadow-window` clearly labeled experimental, macOS-only, and non-core
- keep terminal superpowers experimental, opt-in, and config-gated
