# Local Smoke Testing Against An Existing Bot

This is the safest way to test the public repo against an already-running local bot without putting private secrets into the public tree.

It is designed for the case where you already have another local bridge repo using the bot and you want to validate the public repo in parallel.

Hard rule: do not run two long-poll Telegram bridge daemons against the same bot token at the same time.

## What This Smoke Test Does

`npm run smoke:local` creates a temporary `.env` and `bridge.config.toml` under the system temp directory, borrows only the needed local secrets, and runs safe probes against the public repo.

It does:

- `bridgectl capabilities` against an isolated temp config
- a read-only Telegram bot probe using `getMe` and `getWebhookInfo`
- a public `realtime-gateway` smoke test on a separate local port
- auth-boundary checks for `/healthz/details`, `/miniapp`, and `/api/call/bootstrap`

It does not:

- write secrets into this repo
- start the public `telegram-daemon`
- long-poll Telegram updates
- take over the currently running bot session
- run a real end-to-end Telegram message or `/call` flow

That makes it safe to run while another local bridge is still live on the same bot token.

## Basic Usage

If you already have another local bridge repo with a working `.env` and `bridge.config.toml`, point the smoke helper at those files:

```bash
npm run smoke:local -- --env-file /path/to/.env --config-file /path/to/bridge.config.toml
```

If you do not want to point at the source config, provide the authorized chat ID directly:

```bash
npm run smoke:local -- --env-file /path/to/.env --authorized-chat-id 123456789
```

Useful flags:

- `--keep-temp` keeps the temp config directory for inspection
- `--skip-gateway` only runs the capability and Telegram read-only probes
- `--gateway-port 8899` overrides the temporary realtime gateway port
- `--app-server-port 8879` overrides the temporary app-server port
- `--workdir /path/to/repo` changes the workdir embedded in the temp config

## What Good Output Looks Like

The capability section should usually show:

- `TELEGRAM_BOT_TOKEN: present`
- `Telegram daemon: not running`
- `Desktop thread binding: missing ...`
- `Realtime calls: disarmed ...`

That is expected for this smoke path. The helper intentionally does not start the public daemon.

The Telegram probe should show:

- `ok: true`
- `botIdKnown: true`
- `hasUsername: true`

The gateway section should usually show:

- `healthzOk: true`
- `unauthenticatedDetailsStatus: 401`
- `miniAppWithoutLaunchStatus: 404`
- `bootstrapWithoutLaunchStatus: 404`

If `REALTIME_CONTROL_SECRET` is present, the helper also checks authenticated `/healthz/details`.

## When You Need A Maintenance Window Instead

Use a maintenance window if you want to test:

- real Telegram message intake through the public `telegram-daemon`
- public `bridge:claim` plus the live daemon flow
- a real end-to-end `/call` session

Do not run two long-polling bridge daemons against the same Telegram bot token at the same time.

For a full live test on the same bot:

1. Stop the currently running private daemon and gateway.
2. Start the public daemon and public gateway.
3. Run the public `bridge:claim` from the intended Codex Desktop session.
4. Test Telegram message handling and `/call`.
5. Stop the public runtime and restore the private one.

If you are not ready to briefly interrupt the live private bridge, stay with `npm run smoke:local`.

When you do use a maintenance window, keep these commands and files open:

- `npm run bridge:capabilities`
- `npm run bridge:ctl -- status`
- `npm run bridge:ctl -- call status`
- `.bridge-data/telegram-daemon.log`
- `.bridge-data/realtime-gateway.log`
