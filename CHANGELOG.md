# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Gated Telegram `/terminal` controls for the optional terminal lane:
  `/terminal status`, `/terminal init`, `/terminal ask <prompt>`, and
  explicit `/terminal chat on|off`.
- Terminal routing policy that sends normal text/document work to the
  verified terminal lane only after opt-in, while native media, image
  generation, web-search, live-call, and desktop-control requests stay on
  the primary bridge path.
- `docs/capability-matrix.md` — concise public map of reliable base
  behavior, optional provider-backed features, experimental terminal/call
  surfaces, unsupported defaults, and safe publishing checks.
- `docs/launch-todo.md` — live status tracker for the public-launch flip,
  splitting work into "done", "outstanding manual GitHub UI", "assets and
  content", "after the repo flips public", and "ongoing maintenance"
  buckets.
- README status blockquote under the badge row noting that `v0.1.0` is
  tagged.
- Latest-release shields.io badge in the README badge row.
- Seven new FAQ entries covering voice messages, file delivery, session
  switching, data privacy, phone control, and laptop-open requirement.
- Second "What It Looks Like" transcript in README showing file and voice
  note interactions alongside the existing text-only example.
- README launch poster and workflow infographic assets under `assets/` to
  make the capability model easier to scan before setup.
- Quickstart section in `llms.txt` so AI assistants can guide setup
  directly from the structured project summary.
- Terminal-lane and capability-boundary sections in `llms.txt` so AI
  assistants understand safe tmux, explicit superpower gates, and unsupported
  surfaces.
- "Why people use it" section in `llms.txt` for richer AI-discoverable
  context.

### Changed
- Terminal workers now default to `gpt-5.5` with low reasoning and launch
  with Codex web search enabled when the optional lane is enabled.
- Terminal automation errors are compacted before Telegram/log display so
  osascript bodies and local paths do not leak through failure text.
- `bridge:capabilities` reports terminal-lane readiness and gates without
  exposing user-owned terminal titles or scrollback.
- Security, contributing, issue, and pull request guidance now call out
  terminal-lane safety gates alongside Telegram staging and live `/call`.
- README "How It Fits Together" Mermaid diagram now labels every edge
  with the data that flows along it.
- README docs map reorganized: "Operating safely" split into
  "Security and privacy" (user-facing) and "Contributing and maintenance"
  (contributor-facing), with internal launch checklists moved out of the
  top-level map.
- README "Start Here" and "The Core Flow" sections merged into one
  streamlined section.
- README SEO keyword footer expanded with more natural-language phrases
  that match how people actually search.
- `docs/architecture.md` component and task-flow diagrams now include
  descriptive edge labels.
- `CONTRIBUTING.md` no longer references a private sibling repo.
- `docs/launch-todo.md` repo visibility updated to PUBLIC.
- Wiped local runtime residue (`dist`, `tmp`) via
  `npm run clean:local-state -- --apply` before re-running the full
  `npm run check` pipeline. Logs and any other runtime state remain out
  of scope of the public repo via `.gitignore` (`.bridge-data`, `.env`,
  `.env.local`, `bridge.config.toml`, `coverage`, `output`, `tmp`,
  `dist`, `*.log`).

## [0.1.0] - 2026-04-08

First tagged public release of the bridge.

### Added
- README rewrite for newcomer clarity and discoverability:
  - Tagline blockquote under the H1 disambiguating "Codex" → "OpenAI Codex
    Desktop" so first-time visitors do not mistake it for the deprecated 2021
    OpenAI Codex model.
  - 30-second TL;DR block (what / who / what you need / what's optional /
    where it runs).
  - Quickstart code block immediately after the TL;DR with the real public
    clone URL instead of the previous `<your-fork-or-local-path>` placeholder.
  - "What It Looks Like" section with a mocked interaction transcript.
  - "Why People Use It" section with concrete value bullets.
  - Reorganized so "What It Is / What It Is Not" comes early, the long-form
    "Base Bridge Setup" section is now explicitly the long version of the
    Quickstart, and the "Start Here" doc list is trimmed to three essentials.
  - Banner alt text rewritten to describe the **product** (for screen readers
    and search engines) rather than only the visual style.
  - Expanded badge row with TypeScript, GitHub stars, forks, issues, last
    commit, and PRs Welcome shields, all using the existing
    `img.shields.io` allowlisted host.
  - Star History chart section near the bottom.
  - "See Also" footer linking to OpenAI Codex, Telegram Bot API, Telegram
    Mini Apps, OpenAI Realtime, and Model Context Protocol so AI assistants
    can ground themselves on the surrounding ecosystem.
  - SEO/GEO keyword footnote at the end so search and assistant indexers
    pick up the natural-language phrasing of what this project is.
- `llms.txt` at the repo root following the llms.txt convention
  (<https://llmstxt.org>) so language models and AI assistants can ingest
  the project structure and cite it accurately.
- `docs/github-repo-settings.md` documenting the manual GitHub Settings
  actions for discoverability (About description, topic list, social
  preview image, Discussions, branch protection, Dependabot, awesome-list
  submissions, maintenance signals). [github-launch-checklist-v1.md](docs/github-launch-checklist-v1.md)
  now defers to it for topic and About details.
- Expanded `package.json` with `homepage`, `repository`, `bugs`, and
  `license` fields plus a broader `keywords` array (added `openai-codex`,
  `coding-agent`, `agentic-coding`, `remote-coding`, `mobile-coding`,
  `realtime-api`, `image-generation`, `elevenlabs`, `google-genai`,
  `nodejs`, `node22`, `bridge`, `long-polling`).
- Question-style FAQ entries oriented toward how people actually search:
  "What is telegram-codex-bridge?", "Can I use OpenAI Codex from my phone
  with this?", "Is this hosted or local?", "How do I send a file or photo
  to Codex from Telegram?", "Can Codex send files back to me in Telegram?",
  "Does this work on Linux and Windows, or only macOS?", "What is the
  difference between `shared-thread-resume` and `autonomous-thread`?",
  "Is live `/call` a real Telegram voice call?", "Can I run two Telegram
  bridges against the same bot token?".
- URL allowlist entries in `scripts/public-audit-lib.mjs` for `openai.com`
  (the marketing root, complementing `api.openai.com` and `platform.openai.com`),
  `api.star-history.com` and `www.star-history.com` (for the README star
  history chart), and `llmstxt.org` (for the `llms.txt` convention link).
- Hero banner in the README at `assets/banner.jpg` (ukiyo-e woodblock style
  illustration of a traveler connecting to a distant cottage). Generated via
  Google Gemini 3.1 Flash Image Preview. All EXIF and C2PA provenance
  metadata stripped before committing. The exact path is pinned in
  `BINARY_ASSET_ALLOWLIST` in `scripts/public-audit-lib.mjs` so the public
  audit passes it.
- `.editorconfig` to standardize indentation, line endings, and whitespace.
- `.nvmrc` pinning the Node version to `22` for contributors using nvm.
- Regression tests covering the new public-audit skip list for `CODEOWNERS`
  and the case-insensitive legacy-brand rule.
- Regression test confirming legacy process names never match the managed
  daemon/gateway detection regexes.
- Ambient TypeScript declaration files (`scripts/public-audit-lib.d.mts`,
  `scripts/secret-scan-lib.d.mts`) so `npm run typecheck` stays clean on the
  two `.mjs` helpers imported from tests.
- CI, license, and Node status badges in the README.
- Dependabot grouping for non-major npm and GitHub Actions updates so the
  weekly update batch lands as one PR per ecosystem.

### Changed
- `npm run check` now also runs `npm run typecheck` so type regressions in
  tests fail CI instead of only being caught by developers locally.
- `scripts/public-audit-lib.mjs` widened the legacy-brand rule to catch
  case-insensitive variants anywhere in tracked files (removed the narrower
  `-avatar` rule it subsumes).
- `scripts/clean-local-state.mjs` now also cleans `output/` and `tmp/`
  runtime directories.
- `docs/github-launch-checklist-v1.md` now defers to
  `docs/public-ready-signoff.md` as the authoritative privacy/security gate
  and only covers GitHub-specific presentation checks on top.
- `CODEOWNERS` replaces the placeholder reviewer with a real default and a
  clearer comment for future maintainer additions.
- `LICENSE` copyright line now reads
  `Copyright (c) 2026 the telegram-codex-bridge contributors`.

### Removed
- Legacy private brand name from `src/core/util/process-patterns.ts` regex
  alternatives and from the corresponding `tests/process-patterns.test.ts`
  assertions. Managed process detection now only matches the public
  `bridge-*` names and the `node`/`bun` script patterns.

### Fixed
- Resolved two moderate transitive vulnerabilities in `hono` /
  `@hono/node-server` by updating both within the `@modelcontextprotocol/sdk`
  semver range. `npm audit --omit=dev` now reports zero vulnerabilities.
- Added `output/` and `tmp/` to `.gitignore` so runtime residue (generated
  images, staging directories) cannot be accidentally committed by
  `git add .`.
