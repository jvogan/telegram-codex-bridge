import { describe, expect, test } from "vitest";

import { extractMarkdownImageReferences } from "../src/core/telegram/markdown-images.js";

describe("extractMarkdownImageReferences", () => {
  test("strips standalone markdown image lines and collects the paths", () => {
    const result = extractMarkdownImageReferences([
      "Intro paragraph.",
      "![Fig. 1](/tmp/pdfcheck/litl-05.png)",
      "Closing line.",
    ].join("\n"));

    expect(result.cleanedText).toBe([
      "Intro paragraph.",
      "Closing line.",
    ].join("\n"));
    expect(result.references).toEqual([
      {
        altText: "Fig. 1",
        rawPath: "/tmp/pdfcheck/litl-05.png",
      },
    ]);
  });

  test("keeps surrounding text while removing inline image markdown", () => {
    const result = extractMarkdownImageReferences("See ![Fig. 2](./fig2.png) below.");

    expect(result.cleanedText).toBe("See Fig. 2 below.");
    expect(result.references).toEqual([
      {
        altText: "Fig. 2",
        rawPath: "./fig2.png",
      },
    ]);
  });

  test("treats markdown links to image files as deliverable image references", () => {
    const result = extractMarkdownImageReferences([
      "Here is the requested figure:",
      "",
      "[Figure 1](/tmp/example-figure.png)",
    ].join("\n"));

    expect(result.cleanedText).toBe([
      "Here is the requested figure:",
      "",
    ].join("\n"));
    expect(result.references).toEqual([
      {
        altText: "Figure 1",
        rawPath: "/tmp/example-figure.png",
      },
    ]);
  });
});
