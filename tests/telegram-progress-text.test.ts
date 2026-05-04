import { describe, expect, test } from "vitest";

import {
  telegramDirectImageHeartbeatText,
  telegramProgressText,
  telegramTurnHeartbeatText,
  telegramTurnStartText,
  telegramTurnSubmittedText,
} from "../src/core/telegram/progress-text.js";

describe("Telegram progress text", () => {
  test("does not describe a newly submitted turn as still working", () => {
    expect(telegramTurnStartText()).toBe("Starting now.");
    expect(telegramTurnSubmittedText()).toBe("Working on it. I'll send the result here when it's ready.");
    expect([
      telegramProgressText(),
      telegramProgressText("Downloading image."),
      telegramTurnStartText(),
      telegramTurnSubmittedText(),
    ].join("\n")).not.toMatch(/still working on that/i);
  });

  test("keeps progress details concise", () => {
    expect(telegramProgressText()).toBe("Working on it.");
    expect(telegramProgressText("  Downloading file.  ")).toBe("Working on it.\nDownloading file.");
  });

  test("renders truthful active-turn heartbeats with elapsed time and accepted turn id", () => {
    expect(telegramTurnHeartbeatText({
      elapsedMs: 73_000,
      stage: "submitted",
      workload: "image_generation",
      turnId: "019dd4c1-1f43-7570-afa4-b026fd23721a",
    })).toBe([
      "Still active.",
      "Elapsed: 1m 13s.",
      "Codex accepted the turn (019dd4c1...).",
      "Image generation can take a few minutes; I will attach the result when Codex surfaces it.",
    ].join("\n"));
  });

  test("renders direct image provider heartbeat without claiming Codex activity", () => {
    expect(telegramDirectImageHeartbeatText({ elapsedMs: 12_000 })).toBe([
      "Generating image...",
      "Elapsed: 12s.",
      "Waiting on the bridge image provider.",
    ].join("\n"));
  });
});
