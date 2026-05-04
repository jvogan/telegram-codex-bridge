# Launch TODO

A live status tracker for what is done versus what is still outstanding around the public launch. Update as items land. For the *how* of each item, follow the link to the dedicated doc.

Last reviewed: 2026-05-02, on `main`.

## Status snapshot

- **Repo visibility:** PUBLIC
- **Latest tag:** `v0.1.0`
- **CI:** green through `npm run check` (build, typecheck, tests, docs drift, security audit)
- **Discussions:** enabled
- **Topics:** 20 / 20 (max) — see [github-repo-settings.md](github-repo-settings.md)
- **About description:** updated to the canonical line in [github-repo-settings.md](github-repo-settings.md)

## Done (no action needed)

- [x] README rewritten for newcomer clarity (TL;DR, quickstart with real clone URL, mocked transcript, "What It Is / Is Not" pulled forward, expanded badge row, Star History chart, See Also footer)
- [x] "Codex" disambiguated to "OpenAI Codex Desktop" everywhere it could trip a first-time visitor
- [x] `llms.txt` added at repo root (GEO / AI assistant ingestion)
- [x] [docs/github-repo-settings.md](github-repo-settings.md) added as the manual GitHub Settings checklist
- [x] [docs/faq.md](faq.md) expanded with question-style entries that match common search queries
- [x] `package.json` keywords expanded; `homepage`, `repository`, `bugs`, `license` fields added
- [x] URL allowlist in `scripts/public-audit-lib.mjs` widened for `openai.com`, `api.star-history.com`, `www.star-history.com`, `llmstxt.org`
- [x] CHANGELOG entries moved under `[0.1.0] - 2026-04-08`
- [x] Tag `v0.1.0` pushed to origin
- [x] GitHub Release `v0.1.0` published with notes
- [x] About description updated via `gh repo edit`
- [x] 20 topics set on the GitHub repo via `gh repo edit`
- [x] Discussions enabled via `gh repo edit`
- [x] Repo visibility flipped to public
- [x] Local runtime residue wiped via `npm run clean:local-state -- --apply`
- [x] Tracked-file secret scan green (`npm run check:security`)
- [x] Capability boundaries documented in [capability-matrix.md](capability-matrix.md)
- [x] `llms.txt` updated so AI assistants see the safe tmux lane, optional provider gates, and unsupported/default-disabled surfaces
- [x] README includes static overview artwork for the capability story and workflow model
- [x] `assets/social-preview.jpg` rendered at 1280x640 with the repo name and social-card tagline

## Outstanding — manual, GitHub UI only

These can only be done in the GitHub web UI. None of them block the public flip; they all polish the launch.

- [ ] **Upload the social preview image.** Settings → Social preview → upload `assets/social-preview.jpg` (1280x640). Without this, GitHub serves a generic gradient when the repo is shared on Twitter / Bluesky / LinkedIn / Slack. **High visibility win.**
- [ ] **Add branch protection on `main`.** Settings → Branches → add a rule for `main`: require pull requests, require the **CI** status check to pass. Optional: require linear history. Minimum protection that keeps the public history honest without slowing solo work down.
- [ ] **Pin a Show & Tell discussion.** Now that Discussions are enabled, pin one Show & Tell post with a short demo transcript and a couple of common starter prompts. Pin one Q&A post linking to [faq.md](faq.md) and [troubleshooting.md](troubleshooting.md) so the most common help requests have a self-serve answer.

## Outstanding — assets and content

- [ ] **Demo GIF or screenshot.** The README now has static overview artwork and a mocked transcript. A real 10–15 second GIF (Telegram → bot → reply) would still help users see the product in motion. Drop it into `assets/` and update `BINARY_ASSET_ALLOWLIST` in `scripts/public-audit-lib.mjs` to allow the new asset path.
- [ ] **Optional: short blog post or X / Bluesky / LinkedIn thread** on launch day. A single inbound link from a real domain dramatically improves Google's confidence in the repo. Link the demo GIF and the README.

## Outstanding — now that the repo is public

These are post-launch tasks.

- [ ] **Submit to relevant awesome-lists** by opening PRs against:
  - `awesome-telegram`
  - `awesome-openai`
  - `awesome-mcp`
  - `awesome-ai-agents`
  - `awesome-coding-agents`
- [ ] **Mention in MCP and Codex community channels.** Many users discover dev tools through community share-outs, not search.
- [ ] **Cross-link from a personal site or blog post** if you have one.

## Maintenance signals (ongoing, not blocking)

These quietly raise the repo's "is this alive?" signal once it is public:

- [ ] Reply to issues within a few days, even just to acknowledge.
- [ ] Merge or close stale Dependabot PRs weekly.
- [ ] Push at least one substantive commit per month so the **last commit** badge stays fresh.
- [ ] Cut a real `0.2.0` (or `0.1.1`) tag the next time meaningful changes accumulate, instead of letting `[Unreleased]` grow indefinitely.

## Reference

- Settings how-to: [github-repo-settings.md](github-repo-settings.md)
- Privacy/security gate before any public push: [public-ready-signoff.md](public-ready-signoff.md)
- Public-launch presentation checks: [github-launch-checklist-v1.md](github-launch-checklist-v1.md)
