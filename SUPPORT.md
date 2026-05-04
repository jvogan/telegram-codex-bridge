# Support

Use the repository issue tracker for:

- reproducible bugs
- docs problems
- public feature requests

When opening an issue, include:

- the command you ran
- the relevant status output from `npm run bridge:capabilities` or `npm run bridge:ctl -- status`
- the smallest relevant log snippet from `.bridge-data/telegram-daemon.log` or `.bridge-data/realtime-gateway.log`

Do not post:

- bot tokens
- API keys
- raw Telegram init-data
- private chat IDs unless you intentionally redact them
- full local paths that include personal usernames

For security-sensitive reports, follow [SECURITY.md](SECURITY.md) instead of opening a public issue with exploit details.
