# Troubleshooting

Use this page when setup stalls or `bridge:capabilities` says something is missing.

For the full operator view of logs, status fields, and call artifacts, see [observability.md](observability.md).

## Readiness Checklist

`npm run bridge:capabilities` is the authoritative readiness report.

For the base bridge, look for:

- `TELEGRAM_BOT_TOKEN: present`
- `Authorized chat: ...`
- `Telegram daemon: running`
- `Desktop thread binding: ready` when using `shared-thread-resume`

For optional providers, look for:

- `OPENAI_API_KEY: present`
- `ELEVENLABS_API_KEY: present` only if you want ElevenLabs TTS
- `GOOGLE_GENAI_API_KEY: present` only if you want Google image fallback

For live `/call`, also confirm:

- `Realtime calls: ready ...`
- the gateway/control-channel wording is healthy rather than missing or disconnected

For the optional terminal lane, `bridge:capabilities` shows the configured gates. Use the live status command for terminal discovery and lock state:

- `npm run bridge:ctl -- terminal status`
- `/terminal status`

## `Bridge config not found`

Likely cause:

- `bridge.config.toml` does not exist yet

Next step:

```bash
cp bridge.config.example.toml bridge.config.toml
```

## `TELEGRAM_BOT_TOKEN is required`

Likely cause:

- `.env` does not exist yet
- `TELEGRAM_BOT_TOKEN` is empty or misspelled

Next step:

```bash
cp .env.example .env
```

Then put the bot token in `.env` and rerun the command.

## `Codex Desktop could not be found automatically`

Likely cause:

- `bridge.codex_binary` is blank and the runtime could not resolve `codex` automatically
- `CODEX_BINARY` is unset
- `codex` is not on `PATH`

Next step:

- set one of these, in order of preference:
  - `bridge.codex_binary` in `bridge.config.toml`
  - `CODEX_BINARY` in your shell environment
  - a `codex` binary on `PATH`
- then rerun `npm run start:telegram`

## `Terminal lane is disabled in bridge.config.toml.`

Likely cause:

- `[terminal_lane].enabled` is still `false`

Next step:

- leave it disabled unless you specifically want the experimental tmux lane
- if you do, install `tmux`, set `[terminal_lane].enabled = true`, then run:

```bash
npm run bridge:capabilities
npm run bridge:ctl -- terminal init
npm run bridge:ctl -- terminal status
```

The default terminal lane is tmux-only, bridge-owned, `gpt-5.5` low, read-only, and never-approval. More powerful modes are available only after changing the explicit config gates. Telegram uses it only after `/terminal ask ...` or `/terminal chat on`.

## `tmux` was not found

Likely cause:

- the safe terminal lane is enabled, but `tmux` is not installed or not on `PATH`

Next step:

- install `tmux`
- rerun `npm run bridge:capabilities`
- rerun `npm run bridge:ctl -- terminal init`

Do not switch to iTerm2, Terminal.app, or existing panes just to bypass a missing `tmux` install unless you deliberately want the user-owned terminal gate.

## `A tmux session with the configured terminal lane name already exists`

Likely cause:

- an existing user-created tmux session already uses `terminal_lane.session_name`
- a previous bridge-owned session lost its owner metadata

Next step:

- inspect it manually with `tmux ls`
- change `terminal_lane.session_name`, or close the unrelated tmux session yourself

The bridge intentionally refuses to claim a session unless the owner nonce matches bridge state.

## `User-owned terminal sessions are gated`

Likely cause:

- `backend = "iterm2"`, `backend = "terminal-app"`, or `backend = "auto"` was selected while `terminal_lane.allow_user_owned_sessions = false`

Next step:

- decide whether you want Codex to adopt an already-running terminal session
- if yes, set:

```toml
[terminal_lane]
enabled = true
allow_user_owned_sessions = true
backend = "iterm2" # or "terminal-app" or "auto"
daemon_owned = false
```

Then run:

```bash
npm run bridge:ctl -- terminal status
npm run bridge:ctl -- terminal lock
```

## Unlocking terminal superpowers

For a bridge-owned tmux worker that can edit files, set:

```toml
[terminal_lane]
enabled = true
backend = "tmux"
profile = "power-user"
sandbox = "workspace-write"
approval_policy = "on-request"
daemon_owned = true
allow_terminal_control = true
```

Then run:

```bash
npm run bridge:capabilities
npm run bridge:ctl -- terminal init
```

This is intentionally opt-in. `danger-full-access` is not part of the public terminal lane config.

## `No pending private-chat updates were found.`

Likely cause:

- you have not sent `/start` to the bot yet from the Telegram account you want to authorize

Next step:

1. open Telegram
2. send `/start` to the bot
3. rerun:

```bash
npm run telegram:discover
```

## `Webhook configured: yes (url redacted)` and long polling will not work

Likely cause:

- the bot still has a webhook from an earlier hosted setup

Next step:

```bash
npm run telegram:discover -- --clear-webhook
```

If you need extra context while debugging setup, rerun `npm run telegram:discover -- --verbose`. That still keeps the webhook path redacted.

## `No matching desktop Codex threads.`

Likely cause:

- the target workspace is not open in Codex Desktop
- you are asking the bridge to attach a thread that does not exist in the current local thread history

Next step:

- open the target workspace in Codex Desktop first
- then rerun `npm run bridge:claim` from that session

## `Desktop thread binding: missing`

Likely cause:

- you have not claimed or attached the desktop Codex thread yet

Next step:

```bash
npm run bridge:claim
```

Run that from the exact Codex Desktop session you want Telegram to inherit.

## `/call` is unavailable because realtime is disabled

Likely cause:

- `[realtime].enabled` is still `false`

Next step:

- finish the base bridge first
- then set:

```toml
[realtime]
enabled = true
```

## `/call` is unavailable because the gateway control channel is disconnected

Likely cause:

- `realtime-gateway` is not running
- the Telegram daemon is not connected to the local bridge control websocket yet

Next step:

```bash
npm run start:gateway
npm run bridge:ctl -- call arm
npm run bridge:capabilities
```

## `OPENAI_API_KEY` is missing

Likely cause:

- you are trying to use OpenAI-backed media or live `/call` without an OpenAI API key in `.env`

Next step:

- add `OPENAI_API_KEY` to `.env`
- rerun the command or `npm run bridge:capabilities`

## `REALTIME_CONTROL_SECRET` is missing

Likely cause:

- live `/call` is being enabled, but the control secret is not set in `.env`

Next step:

- add a long random `REALTIME_CONTROL_SECRET` to `.env`
- restart or rerun the realtime command that complained

## `cloudflared` is missing or quick tunnel startup fails

Likely cause:

- `realtime.tunnel_mode = "managed-quick-cloudflared"` is enabled, but `cloudflared` is not installed or not on `PATH`

Next step:

- install `cloudflared`
- or switch to:

```toml
realtime.tunnel_mode = "static-public-url"
```

and provide `realtime.public_url`

## `The public Mini App is not reachable. public origin is unreachable (DNS lookup failed)`

Likely cause:

- the quick tunnel URL exists, but the local runtime still cannot reach it through its normal resolver path yet
- the tunnel is still warming up
- your local environment can resolve the hostname with direct DNS queries, but not through the runtime's default lookup path

Next step:

```bash
npm run bridge:ctl -- call arm
npm run bridge:ctl -- call status
tail -n 80 .bridge-data/telegram-daemon.log
```

Look for these fields in the log entry:

- `publicUrl`
- `healthUrl`
- `launchUrl`
- `tunnelUrl`
- `detail`

Look for these fields in `npm run bridge:ctl -- call status` too:

- `lastDisarmReason`
- `lastPublicProbeAt`
- `lastPublicProbeDetail`
- `lastPublicUrl`
- `lastHealthUrl`
- `lastLaunchUrl`

If `call status` keeps showing a DNS lookup failure, verify the public health URL directly from the same machine. If the bridge is using `managed-quick-cloudflared`, give the tunnel a short warmup window before retrying.

If quick tunnel startup exits before producing a URL, the bridge includes a compact tail of recent `cloudflared` warning and error lines in the failure message. Repeated `status_code="429"`, `1015`, or `Too Many Requests` details usually mean the quick tunnel service is rate-limiting new public URLs; the bridge will cool down managed-tunnel recovery before retrying. Wait for `call status` to show the cooldown has expired, or switch to `static-public-url` for a stable endpoint.

## `A Telegram task is already in flight on the shared Codex thread.`

Likely cause:

- the shared-thread bridge is already handling a Telegram turn
- the bound Codex Desktop thread is still busy finishing a previous Telegram request

Next step:

```bash
npm run bridge:ctl -- status
tail -n 80 .bridge-data/telegram-daemon.log
```

Look for these status fields:

- `activeTask`
- `activeTaskStartedAt`
- `activeTaskAge`
- `activeTaskThreadId`
- `queue`

The live `/call` path is intentionally blocked while a shared-thread Telegram task is active. Let the current task finish, or drain the queue first, then rerun:

```bash
npm run bridge:ctl -- call arm
npm run bridge:ctl -- call status
```

## Still Stuck

Use these commands in order:

```bash
npm run telegram:discover
npm run bridge:claim
npm run start:telegram
npm run bridge:capabilities
```

For live `/call`:

```bash
npm run start:gateway
npm run bridge:ctl -- call arm
npm run bridge:capabilities
```
