# FAQ

## What is telegram-codex-bridge?

It is a local-first bridge that connects a Telegram bot to your OpenAI Codex Desktop session. The Telegram bot becomes a remote front door into the bound Codex thread you already run on your machine. Text, files, photos, voice notes, and generated artifacts all flow through it. Live `/call` is an optional Telegram Mini App backed by OpenAI Realtime.

## Can I use OpenAI Codex from my phone with this?

Yes, that is exactly the point. You run Codex Desktop on your laptop, you bind a thread, and then you talk to that thread from any Telegram client — phone, tablet, web, desktop. The bridge keeps the Codex Desktop session alive and routes Telegram messages into it.

## Is this hosted or local?

Local. The bridge is a CLI plus daemon set that runs entirely on your machine. There is no SaaS backend, no remote state, and no third-party trust boundary other than the providers you explicitly enable. Telegram still talks to its own infrastructure, but the bridge itself never leaves your machine.

## Do I need `OPENAI_API_KEY` for the basic Telegram bridge?

No.

For the base Telegram bridge, the only required secret is `TELEGRAM_BOT_TOKEN`.

You only need `OPENAI_API_KEY` if you want:

- OpenAI ASR
- OpenAI image generation
- live `/call`

## How do I send a file or photo to Codex from Telegram?

Once the base bridge is bound, just attach the file or photo to a Telegram message like you would in any chat. The bridge stages the inbound file under `.bridge-data` and continues the bound Codex thread with the staged path. Voice notes are accepted the same way and go through the configured ASR provider.

## Can Codex send files back to me in Telegram?

Yes. When the bound Codex thread saves a file with a clearly named path, the bridge picks it up and delivers it back to Telegram. Generated images and audio replies follow the same path through the bridge runtime. Natural-language image requests use the bridge image provider by default; `TELEGRAM_IMAGE_GENERATION_MODE=codex-native` makes natural image requests prefer native Codex image generation instead.

## Which Codex session should run `npm run bridge:claim`?

Run it from the exact Codex Desktop session you want Telegram to inherit.

If you have multiple Codex windows or workspaces open, do not guess. Use the window that already has the repo/work context you want Telegram to continue.

## What does “point Codex at this repo” actually mean?

It means:

1. clone the repo locally
2. open that folder in Codex Desktop
3. ask Codex for setup help from inside that workspace
4. run `npm run bridge:claim` from that same Codex Desktop session

That is how Telegram inherits the correct Codex thread instead of some other open session.

## What if I want Telegram to use its own thread instead?

Set:

```toml
[bridge]
mode = "autonomous-thread"
```

In that mode, the bridge owns its own persistent Codex thread instead of inheriting a bound desktop session.

## When do I need `cloudflared`?

Only when enabling live `/call` with:

```toml
realtime.tunnel_mode = "managed-quick-cloudflared"
```

If you are not enabling `/call`, you do not need `cloudflared`.

## Do I need `REALTIME_CONTROL_SECRET` if I am not using `/call`?

No.

That secret is only required for live `/call` control paths.

## What if `telegram:discover` shows no private chats?

Send `/start` to the bot from the Telegram account you want to authorize, then run:

```bash
npm run telegram:discover
```

again.

## Can Codex help me set this up without me pasting secrets into chat?

Yes. That is the intended workflow.

This repo’s [AGENTS.md](../AGENTS.md) tells Codex to inspect the local repo state, guide setup in order, and tell you which file to edit next instead of asking you to paste secrets into chat.

## Does this work on Linux and Windows, or only macOS?

The base Telegram bridge is portable. It runs anywhere Node 22 and Codex Desktop run. The only mode that is macOS-only is `shadow-window`, which is experimental and non-core anyway. Live `/call` works on any platform that can run the gateway and reach the public Mini App origin. The optional terminal lane stays disabled by default; bridge-owned tmux works anywhere `tmux` is available, while iTerm2 and Terminal.app adoption are macOS-only and require `terminal_lane.allow_user_owned_sessions = true`.

## Should I install `tmux`?

Only if you want the optional terminal lane. The base Telegram bridge does not need `tmux`. The safe terminal lane starts as a bridge-owned tmux Codex worker with `gpt-5.5` low, read-only sandboxing, and never approvals, so `tmux` is the recommended first terminal backend. Telegram uses it only after `/terminal ask ...` or `/terminal chat on`.

## What does `unlock terminal superpowers` do?

It is a guided config step, not an automatic privilege escalation. Codex should explain the `[terminal_lane]` gates first. Bridge-owned write-capable tmux requires `terminal_lane.profile = "power-user"`, `terminal_lane.sandbox = "workspace-write"`, and `terminal_lane.approval_policy = "on-request"`. User-owned iTerm2, Terminal.app, or existing panes require `terminal_lane.allow_user_owned_sessions = true`.

## What is the difference between `shared-thread-resume` and `autonomous-thread`?

`shared-thread-resume` makes Telegram continue the currently bound desktop Codex thread — Telegram inherits whatever repo, files, and tools that desktop session already has loaded. `autonomous-thread` makes the bridge own its own persistent Codex thread, independent of any open desktop session. Most users want `shared-thread-resume`. See [docs/desktop-codex-integration.md](desktop-codex-integration.md).

## Is live `/call` a real Telegram voice call?

No. Live `/call` is a Telegram Mini App that the bridge launches. The Mini App connects to a local `realtime-gateway` process, which connects to OpenAI Realtime. Audio flows through the Mini App, not Telegram's native voice channel. When the call ends, a structured handoff artifact lands back in the bound Codex thread.

## Can I run two Telegram bridges against the same bot token?

No. Telegram allows only one long-poll consumer per bot token at a time. Running two `telegram-daemon` processes on the same token will starve one of them. If you want to test the public repo against an existing local bot without interrupting it, use `npm run smoke:local` — it is intentionally read-only and uses an alternate-port gateway. See [docs/local-smoke.md](local-smoke.md).

## How do I control my coding agent from my phone?

That is exactly what this project does. Install Codex Desktop on your laptop, set up the bridge, and then use any Telegram client (phone, tablet, web) to send messages, files, and voice notes to your bound Codex session. Replies come back in the same chat.

## Can I send voice messages to Codex?

Yes. Send a voice note in Telegram like you would in any chat. The bridge runs it through the configured ASR provider (OpenAI by default, requires `OPENAI_API_KEY`) and continues the bound Codex thread with the transcribed text.

## What happens to files Codex creates?

When the bound Codex thread saves a file with a clearly named path, the bridge detects it and delivers it back to your Telegram chat automatically. This works for generated images, PDFs, code files, reports, and any other artifact Codex writes to the workspace.

## Can I switch which Codex session Telegram talks to?

Yes. Use `/threads` in Telegram to list available desktop threads, then `/teleport <thread_id>` to verify that the target is idle and switch Telegram to it. Use `/teleport current` for the active Codex Desktop session, or `/teleport back` to return to the previous binding. The older `/attach-current` and `/attach <thread_id>` commands still work. From the operator CLI, use `npm run bridge:claim` from the session you want.

## Is my data sent to any cloud service?

Only the services you explicitly configure. The bridge itself runs entirely locally. Telegram messages travel through Telegram's infrastructure (as they always do). If you enable OpenAI ASR, TTS, or image generation, those requests go to the respective provider APIs. If you do not enable any optional providers, the only external service involved is Telegram itself.

## Do I need to keep my laptop open?

Yes. The bridge and Codex Desktop both run on your local machine. If your laptop sleeps or shuts down, the bridge stops responding. This is by design — local-first means your machine is the runtime.
