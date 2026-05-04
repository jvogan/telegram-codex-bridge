import { describe, expect, test } from "vitest";

import { renderMiniAppHtml } from "../src/core/realtime/webapp.js";

describe("renderMiniAppHtml", () => {
  test("suppresses referrer leakage for tokenized launch urls", () => {
    const html = renderMiniAppHtml({
      bridgeId: "bridge",
      bootstrapUrl: "/api/call/bootstrap",
      launchToken: "launch-token",
      badge: "Bridge Realtime",
      callTitle: "Bridge Call",
      speakerName: "Bridge",
    });

    expect(html).toContain('<meta name="referrer" content="no-referrer" />');
    expect(html).toContain("<title>Bridge Call</title>");
    expect(html).toContain("Bridge Realtime");
    expect(html).toContain('const speakerName = "Bridge"');
    expect(html).toContain('id="startBtn"');
    expect(html).toContain('id="hangupBtn"');
  });

  test("resets the start button and preserves start-failure telemetry", () => {
    const html = renderMiniAppHtml({
      bridgeId: "bridge",
      bootstrapUrl: "/api/call/bootstrap",
      launchToken: "launch-token",
      badge: "Bridge Realtime",
      callTitle: "Bridge Call",
      speakerName: "Bridge",
    });

    expect(html).toContain('function resetStartButton(label = "Start call")');
    expect(html).toContain('function setStartButtonReopenRequired()');
    expect(html).toContain('resetStartButton(options.retryLabel || "Start call")');
    expect(html).toContain('type: "call.start_failed"');
    expect(html).toContain('return "Call start timed out. Retry start."');
    expect(html).toContain('return "Call start cancelled."');
    expect(html).toContain("Reopen from Telegram");
  });

  test("uses correct Realtime content types for seeded history and shows the call limit", () => {
    const html = renderMiniAppHtml({
      bridgeId: "bridge",
      bootstrapUrl: "/api/call/bootstrap",
      launchToken: "launch-token",
      badge: "Bridge Realtime",
      callTitle: "Bridge Call",
      speakerName: "Bridge",
    });

    expect(html).toContain('function seedContentType(role)');
    expect(html).toContain('role === "assistant" ? "output_text" : "input_text"');
    expect(html).toContain('setStatus("Call connected. Limit: up to " + formatDuration(bootstrapData.maxCallMs) + ".")');
    expect(html).toContain('setStatus("Call ending soon due to the time limit.")');
  });

  test("lets the Mini App cancel a hung startup instead of only waiting for timeout", () => {
    const html = renderMiniAppHtml({
      bridgeId: "bridge",
      bootstrapUrl: "/api/call/bootstrap",
      launchToken: "launch-token",
      badge: "Bridge Realtime",
      callTitle: "Bridge Call",
      speakerName: "Bridge",
    });

    expect(html).toContain("let startAbortController = null;");
    expect(html).toContain('hangupBtn.textContent = "Cancel"');
    expect(html).toContain('startAbortController.abort();');
    expect(html).toContain('throw new DOMException("Call start cancelled.", "AbortError")');
  });
});
