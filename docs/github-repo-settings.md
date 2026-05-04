# GitHub Repo Settings

This file lists the GitHub Settings actions you take **in the GitHub web UI**, not in code. Doing them is what makes the repo discoverable in GitHub search, in npm-style topic search, in Google, and in answers from AI assistants.

Treat this as a one-pass checklist on launch day, and revisit whenever the project's positioning changes.

## 1. About sidebar (highest ROI)

GitHub → Settings → top of the page (or click the gear icon next to **About** on the repo home).

- **Description**

  > Local-first bridge that connects your OpenAI Codex Desktop session to a Telegram bot. Talk to your coding agent from anywhere — text, files, voice notes, and optional live realtime calls.

  Keep it under 350 characters. The first ~120 characters are what shows up in GitHub search results, so front-load the searchable terms.

- **Website**

  Either the GitHub Pages URL for this repo (if you ever enable Pages), or `https://github.com/jvogan/telegram-codex-bridge#readme`. Leave blank if you do not have anything better.

- **Topics**

  Topics are what drive GitHub's `topic:` search. They are separate from `package.json` keywords, even though we keep both in sync. Add all of these:

  ```
  telegram
  telegram-bot
  telegram-mini-app
  codex
  codex-desktop
  openai-codex
  ai-coding-assistant
  coding-agent
  agentic-coding
  remote-coding
  mobile-coding
  openai
  openai-realtime
  realtime-api
  model-context-protocol
  mcp
  voice-agent
  speech-to-text
  text-to-speech
  image-generation
  elevenlabs
  google-genai
  typescript
  nodejs
  node22
  local-first
  developer-tools
  bridge
  long-polling
  ```

  GitHub allows up to 20 topics in the UI but the limit changes — add as many of the high-priority ones as it accepts. The first 10 listed above are the most important.

- **Include in the home page** — leave **Releases**, **Packages**, and **Deployments** unchecked unless you actively use them. They take up scarce real estate in the sidebar.

## 2. Social preview image

GitHub → Settings → **Social preview** (under General).

- Upload `assets/social-preview.jpg`. It is a 1280x640 card derived from the README banner with the repo name and "Telegram for OpenAI Codex Desktop" tagline overlaid.
- Without a custom social preview, GitHub serves a generic gradient when the repo is shared on Twitter / Bluesky / LinkedIn / Slack. With one, every share gets a branded card.
- If you regenerate the card later, keep the literal repo name and phrase **"Telegram for OpenAI Codex Desktop"** visible so OCR-aware crawlers and humans both pick it up.

## 3. Discussions

GitHub → Settings → **Features** → check **Discussions**.

- Lowers the bar for users who want to ask questions but feel like a bug report is too heavy.
- Pin one **Show & Tell** discussion with a short demo transcript and a couple of common prompts to seed activity.
- Pin one **Q&A** discussion linking to [docs/faq.md](faq.md) and [docs/troubleshooting.md](troubleshooting.md) so the most common help requests have a self-serve answer.

## 4. Issues

GitHub → Settings → **Features** → confirm **Issues** is enabled (it is by default).

- Issue templates already live under `.github/ISSUE_TEMPLATE/`. Confirm both `bug_report.md` and `feature_request.md` render correctly on a simulated new issue.

## 5. Branch protection

GitHub → Settings → **Branches** → add a rule for `main`.

- Require pull requests before merging
- Require the **CI** status check to pass before merging
- (Optional) require linear history if you prefer rebase-only merges

This is the minimum protection that keeps the public history honest without slowing solo work down.

## 6. Dependabot

Already configured in [.github/dependabot.yml](../.github/dependabot.yml). Confirm in Settings → **Code security and analysis**:

- **Dependabot alerts** — on
- **Dependabot security updates** — on
- **Dependabot version updates** — on (driven by the committed config)

## 7. Discoverability beyond GitHub

These are off-platform but they compound:

- **Submit to relevant awesome-lists** once the repo is public:
  - `awesome-telegram`
  - `awesome-openai`
  - `awesome-mcp`
  - `awesome-ai-agents`
  - `awesome-coding-agents`
- **Post a launch thread** on whichever platform you actually use (X / Bluesky / LinkedIn / Mastodon). Include a short demo asset and link to the README.
- **Cross-link from a personal site or blog post** if you have one. A single inbound link from a real domain dramatically improves Google's confidence in the repo.
- **Mention in MCP and Codex community channels** — many users discover dev tools through community share-outs, not search.

## 8. Maintenance signals

Things that quietly raise the repo's "is this alive?" signal:

- Cut a real `0.1.0` release tag instead of leaving everything under `[Unreleased]` in [CHANGELOG.md](../CHANGELOG.md).
- Reply to issues within a few days, even just to acknowledge.
- Merge or close stale Dependabot PRs weekly.
- Push at least one substantive commit per month so the **last commit** badge stays fresh.

## 9. What this doc is not

This file does **not** cover privacy/security gates. For those, use [public-ready-signoff.md](public-ready-signoff.md) — that is the authoritative pre-publish checklist for runtime residue, secret hygiene, and brand sanitization.
