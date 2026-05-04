# Public Repo Guidance

This repository is intended to stay GitHub-public-safe and new-user-friendly.

## Setup Playbook For Codex

When a user asks for help setting up this repo, guide them through the real first-run path in order.

1. Inspect whether `.env` and `bridge.config.toml` exist.
2. If they do not exist, tell the user to copy:
   - `.env.example` to `.env`
   - `bridge.config.example.toml` to `bridge.config.toml`
3. Never ask the user to paste secrets into chat. Tell them which keys belong in `.env`.
4. Base bridge first. For the minimal bridge, `TELEGRAM_BOT_TOKEN` is the only required secret:
   - `TELEGRAM_BOT_TOKEN`
   - `telegram.authorized_chat_id`
   - `codex.workdir`
   - `bridge.mode`
   - leave `bridge.codex_binary` blank first unless auto-detection fails
5. Tell the user to run `npm run telegram:configure`, then send `/start` to the bot from Telegram, then run `npm run telegram:discover`.
6. Use `telegram:discover` to help the user obtain `telegram.authorized_chat_id`. By default it prints exact chat IDs only; use `--verbose` only when the user needs extra setup context.
7. Use `bridge:claim` or `bridge:connect` only from the exact Codex Desktop session the user wants Telegram to inherit.
8. Use `npm run start:telegram` and `npm run bridge:capabilities` to verify the base bridge before discussing optional features.
9. Treat live `/call` as a second-stage enablement after the base bridge is working.
10. Treat the terminal lane as experimental and gated. It is disabled by default and starts as bridge-owned tmux, `gpt-5.5` low, read-only, never-approval; if a user asks to "unlock terminal superpowers", explain the explicit `[terminal_lane]` settings rather than silently enabling broad powers.

## Terminal Lane Playbook For Codex

Use this only after the base bridge is understood. The terminal lane is disabled by default and must not adopt existing terminals unless the user explicitly asks for that gate. Telegram terminal chat is also explicit: use `/terminal chat on` only after the safe lane is enabled and verified.

For the safe lane:

1. Confirm `tmux` is installed or tell the user to install it.
2. Keep `terminal_lane.backend = "tmux"`, `terminal_lane.profile = "public-safe"`, `terminal_lane.sandbox = "read-only"`, `terminal_lane.approval_policy = "never"`, `terminal_lane.model = "gpt-5.5"`, `terminal_lane.reasoning_effort = "low"`, `terminal_lane.daemon_owned = true`, `terminal_lane.allow_user_owned_sessions = false`, and `terminal_lane.allow_terminal_control = false`.
3. Set only `terminal_lane.enabled = true`.
4. Run `npm run bridge:capabilities`, then `npm run bridge:ctl -- terminal init`, then `npm run bridge:ctl -- terminal status`.
5. Tell the user they can attach with `tmux attach -t telegram-codex-bridge-terminal`.
6. If the user wants Telegram to use the lane, tell them to send `/terminal chat on`; otherwise it remains a one-off `/terminal ask` lane.

For stronger powers, explain the tradeoff first and make the config change explicit:

- bridge-owned write-capable tmux: `terminal_lane.profile = "power-user"`, `terminal_lane.sandbox = "workspace-write"`, `terminal_lane.approval_policy = "on-request"`, and optionally `terminal_lane.allow_terminal_control = true`
- user-owned iTerm2, Terminal.app, or existing tmux panes: `terminal_lane.allow_user_owned_sessions = true`, `terminal_lane.daemon_owned = false`, then use `npm run bridge:ctl -- terminal use ...` and `npm run bridge:ctl -- terminal lock`
- terminal chat mode routes normal text/document work to terminal, but image generation, ASR/TTS, voice replies, live calls, web-search requests, and desktop-control requests should remain on the primary bridge path
- never use `danger-full-access` as part of the public terminal lane guidance
- never claim, clear, interrupt, or stop a user-owned terminal unless the gate is enabled and the user asked for that action

If the user wants to test the public repo against an already-running local bot without interrupting it, prefer:

- `npm run smoke:local -- --env-file /path/to/.env --config-file /path/to/bridge.config.toml`

That smoke path is intentionally read-only plus alternate-port gateway checks. It must not start the public `telegram-daemon`.

If the user asks for troubleshooting, start with:

- `npm run bridge:capabilities`
- `npm run bridge:ctl -- status`
- `npm run bridge:ctl -- call status`
- `npm run bridge:ctl -- terminal status`
- `.bridge-data/telegram-daemon.log`
- `.bridge-data/realtime-gateway.log`

## If The User Asks To Start A Live Call

Treat the normal Telegram path as:

- `call me` or `/call`
- `/call` will arm the live-call surface automatically when it is disarmed
- `/call status` shows the blocker, queue/preemption note, and recent `/call` activity

Local `npm run bridge:ctl -- call arm` is only for manual pre-arm or diagnosis.

Before describing `/call` as ready, still confirm:

1. the base bridge already works
2. `.env` includes:
   - `TELEGRAM_BOT_TOKEN`
   - `OPENAI_API_KEY`
   - `REALTIME_CONTROL_SECRET`
3. `bridge.config.toml` enables realtime and has the intended tunnel settings
4. `npm run bridge:capabilities` agrees the realtime prerequisites are in place

## Do Not Do

- do not invent chat IDs
- do not ask the user to paste secrets into chat
- do not claim a thread from the wrong Codex Desktop session
- do not imply `/call` is ready until `bridge:capabilities` and the realtime prerequisites agree
- do not imply the terminal lane can adopt iTerm2, Terminal.app, or existing tmux panes unless `terminal_lane.allow_user_owned_sessions = true`
- do not imply terminal interrupt/clear controls are available unless `terminal_lane.allow_terminal_control = true`
- do not treat optional providers as required for the base bridge
- do not start the public `telegram-daemon` against a bot token that is already being long-polled by another live bridge

## Public Repo Safety

- never commit `.env`, `.env.local`, `bridge.config.toml`, `.bridge-data`, `dist`, or `node_modules`
- never commit tokens, chat ids, personal usernames, or private bot handles
- never introduce personal names, local machine usernames, or private absolute paths
- never reintroduce private provider integrations or legacy private branding
- keep user-facing product strings configurable through `bridge.config.toml`
- keep `shadow-window` clearly labeled experimental, macOS-only, and non-core unless it is intentionally promoted
- keep terminal superpowers clearly labeled experimental, opt-in, and config-gated
- keep README and docs aligned with the actual command surface and config schema
- run `npm run check` before proposing public-facing changes
- run `npm run check:security` for focused privacy/security review work
- use `npm run clean:local-state` before a public push or before telling the user the workspace is scrubbed

## When Adding Runtime Features

- preserve `shared-thread-resume`, `autonomous-thread`, thread binding, approvals, queueing, and generated artifact delivery
- keep the realtime Mini App flow compatible with the public branding config
- update tests, `scripts/check-docs.mjs`, and `scripts/check-public.mjs` when new public-safety or docs-drift risks appear
