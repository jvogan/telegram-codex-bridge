import { describe, expect, test } from "vitest";

import { redactSmokeJson, redactSmokeValue } from "../scripts/smoke-redaction.mjs";

describe("smoke report redaction", () => {
  test("redacts private paths, launch params, and secret-like assignments", () => {
    const text = [
      `Saved at ${["/Us", "ers/demo/private/out/report.pdf"].join("")}`,
      `Copied from ${["/ho", "me/demo/private/out/report.pdf"].join("")}`,
      "launch=launch-token-value",
      "TELEGRAM_BOT_TOKEN=123456789:secretbotvalue",
      "OPENAI_API_KEY=sk-secret",
      "GOOGLE_GENAI_API_KEY=google-secret",
      "ELEVENLABS_API_KEY=eleven-secret",
      "REALTIME_CONTROL_SECRET=control-secret",
      "CUSTOM_TOKEN=custom-secret",
    ].join(" ");

    const redacted = redactSmokeValue(text);

    expect(redacted).not.toContain(["/Us", "ers/demo"].join(""));
    expect(redacted).not.toContain(["/ho", "me/demo"].join(""));
    expect(redacted).not.toContain("launch-token-value");
    expect(redacted).not.toContain("secretbotvalue");
    expect(redacted).not.toContain("google-secret");
    expect(redacted).not.toContain("eleven-secret");
    expect(redacted).not.toContain("control-secret");
    expect(redacted).not.toContain("custom-secret");
    expect(redacted).toContain("TELEGRAM_BOT_TOKEN=[redacted]");
    expect(redacted).toContain("REALTIME_CONTROL_SECRET=[redacted]");
  });

  test("redacts secret-like JSON fields recursively", () => {
    expect(redactSmokeJson({
      ok: false,
      visible: "regular value",
      nested: {
        googleGenAiApiKey: "google-secret",
        realtimeControlSecret: "control-secret",
        notes: ["OPENAI_API_KEY=sk-secret"],
      },
    })).toEqual({
      ok: false,
      visible: "regular value",
      nested: {
        googleGenAiApiKey: "[redacted]",
        realtimeControlSecret: "[redacted]",
        notes: ["OPENAI_API_KEY=[redacted]"],
      },
    });
  });
});
