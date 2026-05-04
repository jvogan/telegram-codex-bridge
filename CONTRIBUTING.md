# Contributing

Keep this repo generic, portable, and GitHub-safe.

## Core Product Rules

- Preserve `shared-thread-resume`, `autonomous-thread`, thread binding, approvals, queueing, staged attachments, generated artifact delivery, media MCP, and live `/call`.
- Keep provider support aligned with the documented public matrix:
  - ASR: `openai`
  - TTS: `openai`, `elevenlabs`
  - Image generation: `openai`, `google`
- Keep `shadow-window` clearly labeled experimental, macOS-only, and non-core unless it is intentionally promoted.
- Keep terminal powers experimental, opt-in, and config-gated. Do not silently route normal Telegram messages to the terminal lane, adopt user-owned terminals, or enable interrupt/clear controls without the explicit `[terminal_lane]` and `/terminal` gates.
- Keep user-facing strings configurable through the `branding` block in `bridge.config.toml`.

## Public Repo Hygiene

- Never commit `.env`, `.env.local`, `bridge.config.toml`, `.bridge-data`, `dist`, or `node_modules`.
- Never add personal names, private bot handles, local usernames, private absolute paths, or private provider integrations.
- Prefer Mermaid diagrams over screenshots so diagrams stay editable and do not leak image metadata.
- Do not present internal gateway routes as a stable external API.

## Docs Discipline

- Keep the README aimed at Codex Desktop users first.
- Keep docs aligned with the actual runtime command surface and config schema.
- Update `README.md`, `docs/`, and `SECURITY.md` together when behavior changes.
- If you add or remove a command or config key, update `scripts/check-docs.mjs`.

## Verification

Run the full public check before proposing changes:

```bash
npm run check
```

That includes:

- build
- tests
- docs drift checks
- public-safety audit checks

## Pull Requests

- Explain any runtime behavior changes plainly.
- Call out security/privacy implications when touching Telegram staging, live calling, or provider integrations.
- Prefer small, reviewable pull requests over broad refactors.
