import { describe, expect, test } from "vitest";

import { looksLikeBoundSessionRequest } from "../src/core/telegram/bound-session-intent.js";

describe("bound session intent", () => {
  test("detects requests addressed to the bound Codex session", () => {
    expect(looksLikeBoundSessionRequest("Tell the bound session to reply here when it is done.")).toBe(true);
    expect(looksLikeBoundSessionRequest("Have the assistant type the answer in its own session.")).toBe(true);
  });

  test("ignores ordinary task requests", () => {
    expect(looksLikeBoundSessionRequest("Summarize this document and send me the main risks.")).toBe(false);
  });
});
