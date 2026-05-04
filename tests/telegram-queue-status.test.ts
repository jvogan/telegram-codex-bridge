import { describe, expect, test } from "vitest";

import {
  buildQueuedPlaceholder,
  describeTelegramQueueHoldReason,
} from "../src/core/telegram/queue-status.js";

describe("Telegram queue status", () => {
  test("uses privacy-safe copy for shared desktop contention", () => {
    const text = buildQueuedPlaceholder({ kind: "text" }, 0, "desktop_turn_active");

    expect(text).toContain("One moment.");
    expect(text).toContain("Waiting because another reply is in progress.");
    expect(text).not.toMatch(/\b(bridge|desktop|path|session|Codex)\b/i);
  });

  test("renders queued media work without exposing internals", () => {
    const text = buildQueuedPlaceholder({ kind: "voice" }, 2, "codex_busy");

    expect(text).toContain("Queued behind 2 earlier requests.");
    expect(text).toContain("I'll transcribe the audio as soon as this starts.");
    expect(text).not.toMatch(/\b(bridge|desktop|path|session|Codex)\b/i);
  });

  test("distinguishes unverified desktop state from normal busy state", () => {
    expect(describeTelegramQueueHoldReason("desktop_turn_unverified")).toBe("the current reply status is settling");
    expect(describeTelegramQueueHoldReason("desktop_turn_active")).toBe("another reply is in progress");
  });
});
