# Observability

Use this page when you need to diagnose the bridge quickly without reading source first.

## Start Here

Check these in order:

1. `npm run bridge:capabilities`
2. `npm run bridge:ctl -- status`
3. `npm run bridge:ctl -- call status`
4. `npm run bridge:ctl -- terminal status`
5. `.bridge-data/telegram-daemon.log`
6. `.bridge-data/realtime-gateway.log`
7. `.bridge-data/calls/<call-id>/...`

`bridge:capabilities` is the readiness view. It reports base bridge state, provider readiness, live-call readiness, and the configured terminal-lane gates without inspecting terminal scrollback.

`bridge:ctl -- status` is the operator state view.

`bridge:ctl -- call status` is the live-call surface view.

`bridge:ctl -- terminal status` and Telegram `/terminal status` are the optional live terminal lane views. They show the configured backend, selected backend, lock state, sandbox/approval profile, user-owned-session gate, control gate, terminal chat mode, and attach command for tmux.

Telegram `/fallback status` is the optional safe fallback lane view. It shows whether the separate bridge-owned Codex thread is enabled, ready, which thread it is using, its CWD, whether workspace writes are allowed, and whether a fallback task is active.

Default logs are redacted. They should expose state transitions, ids, counts, ages, and blocker labels without dumping raw Telegram content, usernames, prompts, tokens, secrets, or client IPs.

## What The Status Commands Expose

`npm run bridge:ctl -- status` includes:

- bridge mode, owner, and bound thread
- active task id, stage, age, thread, and turn
- current `/call` blocker
- last public Mini App probe detail and timestamp
- most recent failed task summary and error text
- most recent call summary, bundle path, and handoff append state

`npm run bridge:ctl -- call status` includes:

- armed/disarmed call-surface state
- launch-token readiness
- tunnel and public Mini App URLs
- redacted launch URL state for status-safe sharing
- gateway health and bridge control-channel state
- current `/call` blocker
- recent failed task summary and error text
- recent call bundle path and handoff state

## Call-Surface Lifecycle Wording

These states are intentionally distinct:

- `call surface is disarmed`: the operator has not armed `/call`, or it was disarmed later
- `call surface was manually disarmed`: someone explicitly ran `bridgectl call disarm`
- `launch token was already consumed by a client`: the invite was used and must be re-armed for another launch
- `launch token expired`: the invite aged out before the Mini App launched
- `call surface is disarmed (last failure: ...)`: the bridge armed the surface but later disarmed it after a failed public probe

If the call surface is not ready, re-arm with:

```bash
npm run bridge:ctl -- call arm
```

## Log Files

Primary logs:

- `.bridge-data/telegram-daemon.log`
- `.bridge-data/realtime-gateway.log`

Call-specific artifacts:

- `.bridge-data/calls/<call-id>/events.ndjson`
- `.bridge-data/calls/<call-id>/gateway-events.ndjson`
- `.bridge-data/calls/<call-id>/transcript.md`
- `.bridge-data/calls/<call-id>/handoff.json`
- `.bridge-data/calls/<call-id>/handoff.md`

`handoff.json` keeps complete local paths for automation. When `presentation.demo_practice_mode = true`, `handoff.md` shows short filenames for absolute local paths so it is easier to inspect or share in a demo.

## Log/Event Vocabulary

Common `telegram-daemon` messages:

- `task started`
- `task completed`
- `task failed`
- `telegram /call blocked`
- `call surface disarmed`
- `call finalized`

Common `realtime-gateway` messages:

- `call prepared`
- `call browser connected`
- `call started`
- `call browser disconnected`
- `call finalize received`
- `call ended`

For `/call` failures, the daemon logs structured fields such as:

- `blocker`
- `bridgeId`
- `callId`
- `gatewayReady`
- `gatewayConnected`
- `queueId`
- `stage`
- `queuedTasks`
- `pendingApprovals`
- `pendingCallHandoffs`
- `owner`
- `boundThreadId`
- `publicUrl`
- `healthUrl`
- `launchUrl`
- `detail`
- `lastDisarmReason`

Those fields are intended to be stable enough for another coding agent to read the logs and patch the relevant area quickly. Exact chat IDs still appear in `telegram:discover`, because setup requires them, but private-chat labels and raw webhook URLs stay out of the default setup flow and general runtime logs do not expose them either.
