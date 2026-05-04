import { describe, expect, test } from "vitest";

import {
  buildDirectImageGenerationPrompt,
  imageGenerationRequestText,
} from "../src/core/telegram/image-generation-intent.js";

describe("image-generation intent", () => {
  test("combines caption and transcript text for voice-driven image requests", () => {
    expect(imageGenerationRequestText({
      text: "(voice message)",
      transcriptText: "Generate an image for the release announcement.",
    })).toBe("(voice message) Generate an image for the release announcement.");
  });

  test("builds a public-safe direct image prompt", () => {
    const prompt = buildDirectImageGenerationPrompt("Make a cheerful launch poster.");

    expect(prompt).toContain("Make a cheerful launch poster.");
    expect(prompt).toContain("visually clear");
    expect(prompt).toContain("Do not include text labels");
    expect(prompt).not.toContain(["/Us", "ers/"].join(""));
    expect(prompt).not.toContain(".bridge-data");
  });
});
