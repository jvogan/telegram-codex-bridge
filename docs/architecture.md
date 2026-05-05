# Architecture

`telegram-codex-bridge` is a local runtime that binds Telegram to a Codex Desktop session while keeping transport, queueing, staged files, and live-call orchestration outside the Codex thread itself.

## Component Architecture

```mermaid
flowchart LR
  TG["Telegram"] -- "text / files / photos\n/ voice notes" --> TD["telegram-daemon"]
  TD -- "queue & stage" --> ST["BridgeState\n(.bridge-data)"]
  TD -- "continue bound thread" --> CX["Desktop Codex\nsession"]
  CX -- "replies & artifacts" --> TD
  TD -- "ASR / TTS / images" --> MCP["media-mcp"]
  TD -- "call orchestration" --> GW["realtime-gateway"]
  MCP -- "speech-to-text" --> OP["OpenAI APIs"]
  MCP -- "text-to-speech" --> EL["ElevenLabs API"]
  MCP -- "image generation" --> GG["Google GenAI API"]
  GW -- "live audio session" --> OA["OpenAI Realtime"]
  GW -- "call transcript" --> CX
```

### Runtime responsibilities

- `bridgectl`
  - operator CLI for start/stop/status, safe binding changes, live-call control, and optional terminal lane control
- `telegram-daemon`
  - Telegram transport, queue worker, staged attachment handling, provider overrides, and generated artifact delivery
- `realtime-gateway`
  - Mini App launch surface, Telegram init-data verification, call bootstrap, websocket coordination, and final handoff artifacts
- `media-mcp`
  - ASR, TTS, and image-generation tools exposed through MCP
- `BridgeState`
  - local state for queueing, approvals, binding, provider overrides, call surface state, and artifact metadata

## Telegram Task Flow

```mermaid
flowchart LR
  MSG["Telegram message\n(text / file / photo / audio)"] --> DAEMON["telegram-daemon"]
  DAEMON -- "save to .bridge-data" --> STAGE["Stage file or\nextracted text"]
  STAGE -- "voice? transcribe" --> ASR["ASR via\nmedia provider"]
  ASR --> THREAD["Bound or bridge-owned\nCodex thread"]
  STAGE -- "text / image" --> THREAD
  THREAD -- "reply or saved file" --> RESULT["Codex result"]
  RESULT -- "auto-deliver" --> TG["Telegram chat"]
```

Key behavior:

- photos become local image inputs for Codex
- text-like files are inlined when possible
- PDFs and richer documents get best-effort text extraction when supported by host tools
- generated PDFs, reports, spreadsheets, markdown files, and text files can be sent back automatically if the Codex response names the saved path

## Capability Inheritance Model

```mermaid
flowchart TD
  MODE["Bridge mode"] --> SHARED["shared-thread-resume"]
  MODE --> AUTO["autonomous-thread"]
  MODE --> SHADOW["shadow-window"]
  MODE --> TERM["terminal_lane"]
  SHARED --> DESK["Bound desktop Codex thread supplies repo / file / tool / web abilities"]
  AUTO --> OWNED["Bridge-owned Codex thread supplies repo / file / tool / web abilities"]
  SHADOW --> WINDOW["Desktop window automation on the bound thread"]
  TERM --> TMUX["Gated tmux / iTerm2 / Terminal.app Codex lane for explicit /terminal work"]
  BRIDGE["Bridge-managed runtime"] --> EXTRA["Telegram transport, staging, ASR, TTS, image generation, generated artifact delivery, /call"]
```

Mode wording should stay consistent everywhere:

- `shared-thread-resume`: Telegram continues the currently bound desktop Codex thread and inherits repo/file/tool/web abilities from that session
- `autonomous-thread`: the bridge owns its own persistent Codex thread
- `shadow-window`: experimental, macOS-only, and non-core
- `terminal_lane`: experimental, disabled by default, explicit via `/terminal`, gated before workspace-write or user-owned sessions, and primary-bridge fallback for native media/call/desktop requests

## Live `/call` Flow

```mermaid
sequenceDiagram
  participant User as Telegram user
  participant Bot as telegram-daemon
  participant Gateway as realtime-gateway
  participant MiniApp as Telegram Mini App
  participant Realtime as OpenAI Realtime
  participant Codex as Bound Codex thread

  User->>Bot: /call
  Bot->>Gateway: ensure armed launch token and public surface
  Bot-->>User: Mini App launch button
  User->>MiniApp: open Mini App
  MiniApp->>Gateway: bootstrap with Telegram init data + launch token
  Gateway->>Gateway: verify Telegram init data and rate limits
  Gateway->>Codex: request call context pack
  Gateway->>Realtime: create client secret and start call session
  MiniApp->>Realtime: browser-based live audio session
  Realtime-->>Gateway: transcript and lifecycle events
  Gateway->>Codex: final call artifact and summary
  Codex-->>User: follow-up in the bound thread or Telegram
```

## Internal Gateway Routes

These routes are internal implementation details. They are documented for operators and contributors, not as a stable public API:

- `GET /healthz`
- `GET /miniapp`
- `POST /api/call/bootstrap`
- `POST /api/call/hangup`
- `POST /api/call/finalize`
- `WS /ws/call`
- `WS /ws/bridge`
