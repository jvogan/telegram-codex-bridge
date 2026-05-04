export function renderMiniAppHtml(input: {
  bridgeId: string;
  bootstrapUrl: string;
  launchToken: string;
  badge: string;
  callTitle: string;
  speakerName: string;
}): string {
  const escapeHtml = (value: string) => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  const bridgeId = JSON.stringify(input.bridgeId);
  const bootstrapUrl = JSON.stringify(input.bootstrapUrl);
  const launchToken = JSON.stringify(input.launchToken);
  const speakerName = JSON.stringify(input.speakerName);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="referrer" content="no-referrer" />
    <title>${escapeHtml(input.callTitle)}</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <style>
      :root { color-scheme: dark; --bg: #0e1726; --panel: #172337; --muted: #90a0b7; --text: #eef4ff; --accent: #5fd2ff; --danger: #ff7d86; }
      body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; background: radial-gradient(circle at top, #16314f 0%, var(--bg) 55%); color: var(--text); min-height: 100vh; }
      main { padding: 24px 18px 36px; max-width: 720px; margin: 0 auto; }
      .card { background: rgba(23,35,55,.92); border: 1px solid rgba(255,255,255,.08); border-radius: 18px; padding: 18px; box-shadow: 0 18px 50px rgba(0,0,0,.24); backdrop-filter: blur(12px); }
      h1 { margin: 0 0 8px; font-size: 28px; }
      p, li { line-height: 1.45; }
      .muted { color: var(--muted); }
      .row { display: flex; gap: 12px; flex-wrap: wrap; margin-top: 16px; }
      button { appearance: none; border: none; border-radius: 999px; padding: 12px 18px; font: inherit; font-weight: 600; cursor: pointer; }
      button.primary { background: var(--accent); color: #04131d; }
      button.ghost { background: rgba(255,255,255,.08); color: var(--text); }
      button.danger { background: var(--danger); color: #250407; }
      button:disabled { opacity: .55; cursor: default; }
      pre { background: rgba(0,0,0,.28); border-radius: 14px; padding: 14px; white-space: pre-wrap; overflow-wrap: anywhere; min-height: 180px; }
      .pill { display: inline-block; padding: 6px 10px; border-radius: 999px; background: rgba(95,210,255,.16); color: var(--accent); margin-bottom: 14px; }
      audio { width: 100%; margin-top: 14px; }
    </style>
  </head>
  <body>
    <main>
      <div class="card">
        <div class="pill">${escapeHtml(input.badge)}</div>
        <h1>${escapeHtml(input.callTitle)}</h1>
        <p class="muted" id="status">Preparing…</p>
        <div class="row">
          <button class="primary" id="startBtn">Start call</button>
          <button class="danger" id="hangupBtn" disabled>Hang up</button>
        </div>
        <audio id="remoteAudio" autoplay></audio>
        <pre id="transcript"></pre>
      </div>
    </main>
    <script>
      const bridgeId = ${bridgeId};
      const bootstrapUrl = ${bootstrapUrl};
      const launchToken = ${launchToken};
      const speakerName = ${speakerName};
      const transcriptEl = document.getElementById("transcript");
      const statusEl = document.getElementById("status");
      const startBtn = document.getElementById("startBtn");
      const hangupBtn = document.getElementById("hangupBtn");
      const remoteAudio = document.getElementById("remoteAudio");

      const tg = window.Telegram?.WebApp;
      tg?.ready?.();
      tg?.expand?.();

      let peer;
      let dataChannel;
      let controlSocket;
      let localStream;
      let callState = null;
      let startAbortController = null;
      let startInFlight = false;
      let idleWarningTimer = null;
      let idleEndTimer = null;
      let maxDurationWarningTimer = null;
      let assistantDraft = "";
      let durableEvents = [];
      let ending = false;
      let flushedFinalSnapshot = false;
      let launchInviteConsumed = false;
      let terminalStatusMessage = "Call ended.";

      function withTimeout(promise, timeoutMs, label) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label)), timeoutMs);
          Promise.resolve(promise).then(
            value => {
              clearTimeout(timer);
              resolve(value);
            },
            error => {
              clearTimeout(timer);
              reject(error);
            }
          );
        });
      }

      function setStatus(text) {
        statusEl.textContent = text;
      }

      function resetStartButton(label = "Start call") {
        startBtn.disabled = false;
        startBtn.textContent = label;
      }

      function setStartButtonReopenRequired() {
        startBtn.disabled = true;
        startBtn.textContent = "Reopen from Telegram";
      }

      function renderTerminalStatus(message) {
        if (launchInviteConsumed) {
          return message + " Reopen the call from Telegram to start another one.";
        }
        return message;
      }

      function throwIfStartCancelled() {
        if (startAbortController?.signal?.aborted) {
          throw new DOMException("Call start cancelled.", "AbortError");
        }
      }

      function formatDuration(ms) {
        const totalSeconds = Math.max(1, Math.round(ms / 1000));
        if (totalSeconds % 60 === 0) {
          const minutes = totalSeconds / 60;
          return minutes === 1 ? "1 minute" : minutes + " minutes";
        }
        return totalSeconds + " seconds";
      }

      function describeCallEndStatus(reason) {
        switch (reason) {
          case "user_hangup":
            return "Call ended.";
          case "call_start_timeout":
            return "Call start timed out. Retry start.";
          case "call_start_cancelled":
            return "Call start cancelled.";
          case "call_start_failed":
            return "Call setup failed. Retry start.";
          case "call_launch_timeout":
            return "This live-call invite expired before it connected. Reopen the call from Telegram.";
          case "browser_disconnect":
            return "Call connection dropped.";
          case "max_call_duration_reached":
            return "Call reached the maximum duration.";
          case "idle_timeout":
            return "Call ended after being idle.";
          case "prepare_timeout":
            return "The bridge took too long to prepare the call. Retry from Telegram.";
          case "force_end":
            return "Call was ended by the bridge.";
          default:
            return "Call ended.";
        }
      }

      function appendTranscript(prefix, text) {
        if (!text) return;
        transcriptEl.textContent += (transcriptEl.textContent ? "\\n\\n" : "") + prefix + text;
        transcriptEl.scrollTop = transcriptEl.scrollHeight;
      }

      function resetIdleTimers() {
        if (!callState) return;
        if (idleWarningTimer) clearTimeout(idleWarningTimer);
        if (idleEndTimer) clearTimeout(idleEndTimer);
        idleWarningTimer = setTimeout(() => {
          emitRealtimeControl({ type: "call.idle_warning", at: Date.now() });
          setStatus("Idle warning: the call will end if it stays quiet.");
        }, callState.idleWarningMs);
        idleEndTimer = setTimeout(() => {
          void hangup("idle_timeout");
        }, callState.idleTimeoutMs);
      }

      function resetDurationTimers() {
        if (maxDurationWarningTimer) clearTimeout(maxDurationWarningTimer);
        if (!callState?.maxCallMs || callState.maxCallMs <= 0) {
          return;
        }
        const warningLeadMs = Math.min(60000, Math.max(10000, Math.floor(callState.maxCallMs / 2)));
        const warningDelayMs = Math.max(0, callState.maxCallMs - warningLeadMs);
        maxDurationWarningTimer = setTimeout(() => {
          if (!callState || ending) return;
          setStatus("Call ending soon due to the time limit.");
        }, warningDelayMs);
      }

      function sendControl(message) {
        if (controlSocket?.readyState === WebSocket.OPEN) {
          controlSocket.send(JSON.stringify(message));
        }
      }

      function emitRealtimeControl(event, options = {}) {
        if (options.persist !== false) {
          durableEvents.push(event);
          if (durableEvents.length > 512) {
            durableEvents = durableEvents.slice(-512);
          }
        }
        sendControl({ type: "call.event", event });
      }

      function buildFinalSnapshotPayload(reason) {
        if (!callState) return null;
        const finalEvents = [...durableEvents];
        if (assistantDraft.trim()) {
          finalEvents.push({
            type: "assistant.transcript.final",
            at: Date.now(),
            text: assistantDraft.trim(),
          });
        }
        return JSON.stringify({
          callId: callState.callId,
          token: callState.clientToken,
          reason,
          events: finalEvents,
        });
      }

      async function flushFinalSnapshot(reason, options = {}) {
        if (!callState) return;
        if (flushedFinalSnapshot) return;
        const payload = buildFinalSnapshotPayload(reason);
        if (!payload) return;
        flushedFinalSnapshot = true;
        const finalizeUrl = callState.finalizeUrl || "/api/call/finalize";
        if (options.keepalive && navigator.sendBeacon) {
          try {
            const accepted = navigator.sendBeacon(
              finalizeUrl,
              new Blob([payload], { type: "application/json" }),
            );
            if (accepted) {
              return;
            }
          } catch {}
        }
        await fetch(finalizeUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: payload,
          keepalive: Boolean(options.keepalive),
        }).catch(() => undefined);
      }

      function cleanupLocalCallState(options = {}) {
        if (idleWarningTimer) clearTimeout(idleWarningTimer);
        if (idleEndTimer) clearTimeout(idleEndTimer);
        if (maxDurationWarningTimer) clearTimeout(maxDurationWarningTimer);
        controlSocket?.close();
        dataChannel?.close();
        peer?.close();
        localStream?.getTracks().forEach(track => track.stop());
        if (remoteAudio.srcObject) {
          remoteAudio.srcObject = null;
        }
        callState = null;
        controlSocket = null;
        dataChannel = null;
        peer = null;
        localStream = null;
        startAbortController = null;
        startInFlight = false;
        assistantDraft = "";
        durableEvents = [];
        ending = false;
        flushedFinalSnapshot = false;
        maxDurationWarningTimer = null;
        hangupBtn.disabled = true;
        hangupBtn.textContent = "Hang up";
        if (options.reopenRequired) {
          setStartButtonReopenRequired();
        } else {
          resetStartButton(options.retryLabel || "Start call");
        }
      }

      function seedContentType(role) {
        return role === "assistant" ? "output_text" : "input_text";
      }

      function handleRealtimeEvent(event) {
        sendControl({ type: "call.event", event: { type: "raw", at: Date.now(), eventType: event.type, payload: event } });
        if (event.type === "input_audio_buffer.speech_started") {
          resetIdleTimers();
          emitRealtimeControl({ type: "vad", at: Date.now(), state: "speech_started" }, { persist: false });
          return;
        }
        if (event.type === "input_audio_buffer.speech_stopped") {
          emitRealtimeControl({ type: "vad", at: Date.now(), state: "speech_stopped" }, { persist: false });
          return;
        }
        if (event.type === "conversation.item.input_audio_transcription.completed") {
          if (event.transcript) {
            appendTranscript("You: ", event.transcript);
            emitRealtimeControl({ type: "user.transcript.final", at: Date.now(), text: event.transcript });
            resetIdleTimers();
          }
          return;
        }
        if (event.type === "response.output_audio_transcript.delta" || event.type === "response.output_text.delta") {
          const delta = event.delta || "";
          assistantDraft += delta;
          emitRealtimeControl({ type: "assistant.transcript.delta", at: Date.now(), text: delta }, { persist: false });
          resetIdleTimers();
          return;
        }
        if (event.type === "response.output_audio_transcript.done" || event.type === "response.output_text.done") {
          const text = event.transcript || event.text || assistantDraft;
          if (text) {
            appendTranscript(speakerName + ": ", text);
            emitRealtimeControl({ type: "assistant.transcript.final", at: Date.now(), text });
          }
          assistantDraft = "";
          resetIdleTimers();
          return;
        }
        if (event.type === "response.cancelled") {
          assistantDraft = "";
          emitRealtimeControl({ type: "response.interrupted", at: Date.now() });
        }
      }

      async function setupRealtime(bootstrap) {
        callState = bootstrap;
        controlSocket = new WebSocket(bootstrap.wsUrl);
        const handleControlClose = () => {
          if (!callState) return;
          if (!ending) {
            terminalStatusMessage = describeCallEndStatus("browser_disconnect");
            setStatus("Call connection closed. Finalizing…");
            void flushFinalSnapshot("browser_disconnect", { keepalive: true });
          }
          cleanupLocalCallState({ reopenRequired: launchInviteConsumed });
          setStatus(renderTerminalStatus(terminalStatusMessage));
        };
        controlSocket.addEventListener("close", handleControlClose);
        await withTimeout(new Promise((resolve, reject) => {
          controlSocket.addEventListener("open", resolve, { once: true });
          controlSocket.addEventListener("error", reject, { once: true });
        }), bootstrap.startupTimeoutMs, "Control channel timed out.");
        throwIfStartCancelled();
        controlSocket.send(JSON.stringify({
          type: "call.auth",
          token: bootstrap.clientToken,
        }));
        await withTimeout(new Promise((resolve, reject) => {
          const onMessage = (msg) => {
            try {
              const data = JSON.parse(msg.data);
              if (data.type === "call.auth.ok") {
                cleanup();
                resolve();
              }
            } catch {}
          };
          const onClose = () => {
            cleanup();
            reject(new Error("Call authentication failed."));
          };
          const onError = () => {
            cleanup();
            reject(new Error("Call authentication failed."));
          };
          const cleanup = () => {
            controlSocket?.removeEventListener("message", onMessage);
            controlSocket?.removeEventListener("close", onClose);
            controlSocket?.removeEventListener("error", onError);
          };
          controlSocket.addEventListener("message", onMessage);
          controlSocket.addEventListener("close", onClose, { once: true });
          controlSocket.addEventListener("error", onError, { once: true });
        }), bootstrap.startupTimeoutMs, "Control authentication timed out.");
        throwIfStartCancelled();
        controlSocket.addEventListener("message", async (msg) => {
          try {
            const data = JSON.parse(msg.data);
            if (data.type === "call.force_end") {
              await hangup(data.reason || "force_end");
            }
          } catch {}
        });

        peer = new RTCPeerConnection();
        dataChannel = peer.createDataChannel("oai-events");
        dataChannel.addEventListener("message", (msg) => {
          try {
            handleRealtimeEvent(JSON.parse(msg.data));
          } catch {}
        });
        peer.addEventListener("track", (event) => {
          remoteAudio.srcObject = event.streams[0];
        });
        localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
        throwIfStartCancelled();
        localStream.getTracks().forEach(track => peer.addTrack(track, localStream));

        const offer = await peer.createOffer();
        await peer.setLocalDescription(offer);
        const response = await withTimeout(fetch("https://api.openai.com/v1/realtime/calls", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + bootstrap.ephemeralKey,
            "Content-Type": "application/sdp",
          },
          body: offer.sdp,
          signal: startAbortController?.signal,
        }), bootstrap.startupTimeoutMs, "OpenAI Realtime startup timed out.");
        if (!response.ok) {
          throw new Error("OpenAI Realtime call bootstrap failed with HTTP " + response.status + ".");
        }
        const answerSdp = await response.text();
        throwIfStartCancelled();
        await peer.setRemoteDescription({ type: "answer", sdp: answerSdp });

        await withTimeout(new Promise((resolve) => {
          dataChannel.addEventListener("open", resolve, { once: true });
        }), bootstrap.startupTimeoutMs, "Realtime data channel timed out.");
        throwIfStartCancelled();
        dataChannel.send(JSON.stringify({
          type: "session.update",
          session: {
            type: "realtime",
            model: bootstrap.model,
            instructions: bootstrap.instructions,
            audio: {
              input: {
                transcription: { model: bootstrap.transcriptionModel || "gpt-4o-mini-transcribe" },
                turn_detection: {
                  type: "semantic_vad",
                  interrupt_response: true,
                  create_response: true
                }
              },
              output: { voice: bootstrap.voice }
            }
          }
        }));
        for (const seed of bootstrap.seedMessages) {
          dataChannel.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
              type: "message",
              role: seed.role,
              content: [{ type: seedContentType(seed.role), text: seed.text }]
            }
          }));
        }
        launchInviteConsumed = true;
        emitRealtimeControl({ type: "call.started", at: Date.now() });
        resetIdleTimers();
        resetDurationTimers();
      }

      async function bootstrap() {
        const response = await fetch(bootstrapUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: startAbortController?.signal,
          body: JSON.stringify({
            initData: tg?.initData || "",
            bridgeId,
            launch: launchToken
          })
        });
        if (!response.ok) {
          const raw = await response.text();
          let message = "Bootstrap failed.";
          try {
            const payload = JSON.parse(raw);
            if (payload && typeof payload.error === "string" && payload.error) {
              message = payload.error;
            }
          } catch {
            if (raw) {
              message = raw;
            }
          }
          throw new Error(message);
        }
        return response.json();
      }

      async function start() {
        if (startInFlight || callState) return;
        startAbortController = new AbortController();
        startInFlight = true;
        hangupBtn.disabled = false;
        hangupBtn.textContent = "Cancel";
        startBtn.disabled = true;
        startBtn.textContent = "Starting…";
        transcriptEl.textContent = "";
        terminalStatusMessage = "Call ended.";
        try {
          setStatus("Starting call…");
          const bootstrapData = await bootstrap();
          await setupRealtime(bootstrapData);
          startAbortController = null;
          startInFlight = false;
          hangupBtn.disabled = false;
          hangupBtn.textContent = "Hang up";
          startBtn.textContent = "Call active";
          setStatus("Call connected. Limit: up to " + formatDuration(bootstrapData.maxCallMs) + ".");
        } catch (error) {
          const cancelled = Boolean(error?.name === "AbortError");
          const message = cancelled
            ? "Call start cancelled."
            : (error?.message || "Failed to start call.");
          terminalStatusMessage = describeCallEndStatus(cancelled ? "call_start_cancelled" : "call_start_failed");
          if (controlSocket?.readyState === WebSocket.OPEN) {
            emitRealtimeControl({ type: "call.start_failed", at: Date.now(), message });
          }
          if (callState || controlSocket) {
            await flushFinalSnapshot(cancelled ? "call_start_cancelled" : "call_start_failed");
          }
          cleanupLocalCallState({
            reopenRequired: launchInviteConsumed,
            retryLabel: "Retry start",
          });
          const renderedMessage = renderTerminalStatus(message);
          setStatus(renderedMessage);
          transcriptEl.textContent = renderedMessage;
          if (!launchInviteConsumed) {
            startBtn.textContent = "Retry start";
          }
        }
      }

      async function hangup(reason = "user_hangup") {
        if ((!callState && !controlSocket && !startInFlight) || ending) return;
        ending = true;
        if (startInFlight && startAbortController) {
          startAbortController.abort();
        }
        terminalStatusMessage = describeCallEndStatus(reason);
        await flushFinalSnapshot(reason, { keepalive: true });
        cleanupLocalCallState({
          reopenRequired: launchInviteConsumed,
          retryLabel: "Retry start",
        });
        setStatus(renderTerminalStatus(terminalStatusMessage));
      }

      startBtn.addEventListener("click", () => { void start(); });
      hangupBtn.addEventListener("click", () => { void hangup(); });
      window.addEventListener("pagehide", () => {
        if (!callState || ending) return;
        ending = true;
        void flushFinalSnapshot("browser_pagehide", { keepalive: true });
      });
      window.addEventListener("beforeunload", () => {
        if (!callState || ending) return;
        ending = true;
        void flushFinalSnapshot("browser_unload", { keepalive: true });
      });
    </script>
  </body>
</html>`;
}
