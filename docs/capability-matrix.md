# Capability Matrix

Use this page when you need a quick answer to: what can this public repo do reliably today, what needs extra setup, and what is deliberately not part of the default path?

`npm run bridge:capabilities` is still the authoritative local answer. This page explains how to read that answer.

## Reliable Base Path

These work after the base setup is complete: `.env` has `TELEGRAM_BOT_TOKEN`, `bridge.config.toml` has `telegram.authorized_chat_id` and `codex.workdir`, the intended Codex Desktop session is claimed, and `telegram-daemon` is running.

| Capability | Status | Notes |
| --- | --- | --- |
| Telegram text to Codex | Ready | Telegram continues the bound Codex Desktop thread in `shared-thread-resume` mode. |
| Same-session repo/file/tool/web work | Ready | Inherited from the bound Codex Desktop session, not from Telegram itself. |
| Photos and screenshots | Ready | Photos are staged locally and passed to Codex as local image inputs. |
| Documents and files | Ready | Text-like files are inlined when possible; richer files are staged for follow-up inspection. |
| Video attachments | Ready | The bridge stages videos and can provide preview/transcript context when supported by the local/provider setup. |
| Generated artifact return | Ready | Files Codex creates under the working directory can be delivered back to Telegram when the saved path is clear. |
| Queueing and ownership | Ready | The bound thread runs one turn at a time; new Telegram work queues instead of starting parallel turns. |
| Setup discovery | Ready | `telegram:discover`, `bridge:claim`, `bridge:capabilities`, and status commands are the intended first-run path. |

## Optional Providers

These are useful, but not required for the base bridge.

| Capability | Required setup | Notes |
| --- | --- | --- |
| Voice/audio understanding | `OPENAI_API_KEY` with the configured ASR provider enabled | Without ASR, Telegram voice notes can still be staged, but transcription is unavailable. |
| Spoken replies | `OPENAI_API_KEY` or `ELEVENLABS_API_KEY`, depending on provider config | `/speak` is a shortcut; natural language requests for audio replies are also supported. |
| Image generation | `OPENAI_API_KEY` or `GOOGLE_GENAI_API_KEY`, depending on provider config | `/image` is a shortcut; natural language image requests use the bridge image provider by default. Set `TELEGRAM_IMAGE_GENERATION_MODE=codex-native` to prefer native Codex image generation for natural requests. |
| Safe fallback Codex lane | `[bridge.fallback_lane]` enabled or `/fallback enable` after base setup | Optional safe extra capacity for non-mutating tasks while the bound desktop turn is busy. Workspace writes are disabled by default. |
| Live `/call` | `OPENAI_API_KEY`, `REALTIME_CONTROL_SECRET`, realtime config, gateway, and a reachable Mini App origin | Experimental. Use only after the base bridge is working. |

## Experimental Local Operator Surfaces

These are opt-in and should be described conservatively.

| Surface | Default posture | How to verify |
| --- | --- | --- |
| Safe terminal lane | Disabled; when enabled, bridge-owned `tmux`, `gpt-5.5` low, `read-only`, `never` approvals | `npm run bridge:capabilities` then `npm run bridge:ctl -- terminal status` or `/terminal status` |
| Terminal superpowers | Disabled; requires explicit `[terminal_lane]` gates | `npm run bridge:ctl -- terminal unlock-superpowers` prints the required config |
| User-owned terminal adoption | Disabled; requires `terminal_lane.allow_user_owned_sessions = true` | Lock only after the user explicitly asks for iTerm2, Terminal.app, or existing-pane adoption |
| Terminal interrupt/clear controls | Disabled; requires `terminal_lane.allow_terminal_control = true` | Use only after the lane is locked and the user asked for control powers |
| `shadow-window` | Disabled; macOS-only, experimental, non-core | Keep it out of the base setup path |

## Not Supported By The Default Public Path

- no hosted SaaS backend
- no native Telegram voice call
- no silent Telegram-to-terminal chat route; `/terminal chat on` is explicit and still routes native media/call/desktop requests to the primary bridge
- no automatic iTerm2, Terminal.app, or existing tmux adoption
- no safe parallel worker for arbitrary repo/file edits on the same bound thread; the fallback lane is for safe non-mutating work only
- no `danger-full-access` terminal lane guidance
- no encrypted local storage at rest
- no npm package release yet

## Safe Publishing Checklist

- Do not ask users to paste secrets into chat.
- Keep `TELEGRAM_BOT_TOKEN`, provider keys, and `REALTIME_CONTROL_SECRET` in `.env` or `.env.local`.
- Keep `bridge.config.toml`, `.bridge-data`, `dist`, `node_modules`, and logs untracked.
- Treat `telegram:discover` output as setup-sensitive because exact private chat IDs are required there.
- Prefer `npm run bridge:capabilities` for summary readiness; use `bridge:ctl -- terminal status` only when live terminal discovery is needed.
- Before publishing changes, run `npm run check`, `npm run check:public`, `npm run check:security`, and `npm run clean:local-state -- --apply`.
