# Security And Privacy Notes

This document complements [SECURITY.md](../SECURITY.md) with operator-facing guidance for the public repo.

## What Stays Local

By default the bridge stores runtime state in `.bridge-data`. That local state can include:

- queued Telegram task metadata
- staged inbound files
- extracted text from documents
- generated artifact metadata
- live-call logs and final handoff artifacts

Nothing here should be treated as disposable junk. It can contain sensitive user content and local workspace references.

Routine daemon and gateway logs are different from `.bridge-data` artifacts. Logs are redacted by default. Full-fidelity user content stays in staged files, transcripts, and call artifacts where the product actually needs it.

For demos or screen shares, `presentation.demo_practice_mode = true` shortens absolute local paths in readable call handoff markdown. It does not redact the underlying JSON handoff, staged files, transcripts, or local runtime state.

## Secrets

Keep these in `.env` or `.env.local` only:

- `TELEGRAM_BOT_TOKEN`
- `OPENAI_API_KEY`
- `ELEVENLABS_API_KEY`
- `GOOGLE_GENAI_API_KEY`
- `REALTIME_CONTROL_SECRET`

Do not place secrets in:

- tracked markdown examples
- `bridge.config.example.toml`
- test fixtures meant to be copied into real deployments

## Telegram Boundary

Telegram is the user-facing transport, not the execution runtime.

- The bot should be locked down with `telegram.authorized_chat_id`.
- Telegram attachments are staged locally before Codex sees them.
- Telegram slash commands change bridge routing and operator state; they are not mere chat shortcuts.
- `telegram:discover` intentionally shows the exact private chat id, because setup requires it. By default it does not show private-chat labels or raw webhook URLs; use `--verbose` when that extra setup context is worth the privacy tradeoff.

## Live `/call` Boundary

The live call path has the most exposure because it introduces a public Mini App origin.

Current protections include:

- Telegram Mini App init-data verification
- short-lived launch tokens
- rate limits for IPs, bridges, users, and launch tokens
- gateway health checks before launch
- operator-side control protected by `REALTIME_CONTROL_SECRET`
- hard call-duration and daily-budget caps
- operator arm/disarm flow so `/call` does not stay publicly reachable by accident

Recommended posture:

- prefer managed quick tunnels for development
- do not leave the call surface armed indefinitely
- rotate secrets immediately after any suspected leak
- keep the public origin limited to the Mini App surface only

## Terminal Lane Boundary

The optional terminal lane is experimental and disabled by default. In the public repo it is deliberately gated before it can become as powerful as a normal terminal:

- safe default: bridge-owned tmux only
- safe default: `read-only` sandbox and `never` approvals
- power-user mode requires explicit `workspace-write` plus `on-request`
- iTerm2, Terminal.app, and existing user panes require `terminal_lane.allow_user_owned_sessions = true`
- interrupt/clear controls require `terminal_lane.allow_terminal_control = true`
- no silent Telegram auto-routing; `/terminal chat on` is explicit and keeps native media, web-search, live-call, and desktop-control requests on the primary bridge path
- no raw scrollback persistence in bridge state

`npm run bridge:capabilities` shows the configured terminal gates without inspecting terminal scrollback. Use `npm run bridge:ctl -- terminal status` or Telegram `/terminal status` before and after local testing when you need live discovery.

Be more careful with user-owned terminal adoption than bridge-owned tmux. Existing panes may contain scrollback, shell history, paths, or prompts from unrelated work. Only enable `terminal_lane.allow_user_owned_sessions = true` when the user has explicitly chosen that tradeoff.

Do not put tokens, chat IDs, private paths, or private bot handles into terminal-lane prompts or docs. `terminal stop` only stops the matching nonce-owned tmux session; user-owned sessions are left running.

## Public Repo Hygiene

This repo includes automated checks for public safety:

- `scripts/check-docs.mjs` verifies README/docs commands and config keys against the actual runtime surface
- `scripts/check-public.mjs` blocks private branding, local usernames, private-looking handles, private absolute paths, unallowlisted URLs, and unreviewed binary assets
- `scripts/check-security.mjs` runs the production dependency audit, public audit, and tracked-file secret scan
- `scripts/clean-local-state.mjs` reports local runtime residue before a public push and can remove it with `--apply`

Run `npm run check` before opening a public-facing pull request. Run `npm run clean:local-state` before the first public push from a workspace that has been used for live local testing.

## Known Non-Goals

- There is no promise of encrypted local storage at rest.
- The internal gateway routes are not a stable public API.
- This repo does not yet abstract the runtime away from Codex-specific execution.
- This repo is still an experimental public launch, not a production-ready hosted service.
