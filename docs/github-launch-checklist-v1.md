# GitHub Launch Checklist v1

Use this checklist when publishing the repo on GitHub.

Release posture: experimental GitHub launch for Codex Desktop users. Do not describe this repo as production-ready, backend-agnostic, or a hosted service.

## Repository Settings

For the full discoverability checklist (topics, About description, social preview image, Discussions, etc.), see [github-repo-settings.md](github-repo-settings.md). The short version:

Set the GitHub description to:

> Local-first bridge that connects your OpenAI Codex Desktop session to a Telegram bot. Talk to your coding agent from anywhere — text, files, voice notes, and optional live realtime calls.

Set the GitHub topics to match the `keywords` array in `package.json` so npm and GitHub searches stay aligned. The current canonical list is documented in [github-repo-settings.md](github-repo-settings.md).

## Before First Public Push

First, walk through every item in [public-ready-signoff.md](public-ready-signoff.md). That is the authoritative privacy and security gate. This launch checklist only covers GitHub-specific presentation on top of that.

Then, for the GitHub render itself:

- confirm `README.md` renders cleanly on GitHub
- confirm Mermaid diagrams render correctly
- confirm every badge in the README resolves (CI workflow exists at the referenced path, license badge points to `LICENSE`, etc.)
- confirm issue templates and pull request template render correctly on the first simulated issue/PR

## GitHub Features To Enable

- enable GitHub Actions
- enable Dependabot version updates
- enable Dependabot security updates and repository security alerts
- add basic branch protection for the default branch before inviting outside contributions

## First Manual Smoke Pass

- run `npm run smoke:local -- --env-file /path/to/.env --config-file /path/to/bridge.config.toml` first if you are borrowing an existing local bot setup
- configure the bot with `npm run telegram:configure`
- inspect bot state with `npm run telegram:discover`
- claim the current desktop session with `npm run bridge:claim`
- run `npm run bridge:capabilities`
- start the daemon with `npm run start:telegram`
- if live calling is enabled, start `npm run start:gateway`, arm with `npm run bridge:ctl -- call arm`, then launch `/call`
- after the live smoke, disarm `/call`, stop the public runtime, and rerun `npm run clean:local-state`

## Release Posture

- Keep `package.json` marked `"private": true`.
- Treat GitHub release polish as repo presentation work, not npm packaging work.
- Do not describe internal gateway routes as a public API contract.
- Keep README and docs explicit that the base bridge is the primary supported path and live `/call` is still experimental.
- Keep README and docs explicit that default logs are redacted and `.bridge-data` remains local sensitive state.
