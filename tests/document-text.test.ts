import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import { extractDocumentText } from "../src/core/util/document-text.js";

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function makePptxFixture(): string {
  const root = mkdtempSync(join(tmpdir(), "telegram-codex-pptx-"));
  tempRoots.push(root);
  mkdirSync(join(root, "ppt", "slides"), { recursive: true });
  mkdirSync(join(root, "ppt", "notesSlides"), { recursive: true });
  writeFileSync(
    join(root, "ppt", "slides", "slide1.xml"),
    [
      "<p:sld>",
      "<a:p><a:r><a:t>Quarterly plan</a:t></a:r></a:p>",
      "<a:p><a:r><a:t>Revenue &amp; margin</a:t></a:r></a:p>",
      "</p:sld>",
    ].join(""),
  );
  writeFileSync(
    join(root, "ppt", "notesSlides", "notesSlide1.xml"),
    [
      "<p:notes>",
      "<a:p><a:r><a:t>Speaker note</a:t></a:r></a:p>",
      "</p:notes>",
    ].join(""),
  );
  const outputPath = join(root, "deck.pptx");
  execFileSync("zip", ["-qr", outputPath, "ppt"], { cwd: root, stdio: "ignore" });
  return outputPath;
}

describe("extractDocumentText", () => {
  test("extracts slide and note text from pptx documents", async () => {
    const pptxPath = makePptxFixture();

    await expect(extractDocumentText(
      pptxPath,
      "deck.pptx",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    )).resolves.toEqual({
      method: "pptx-xml",
      text: "Speaker note\n\nQuarterly plan\nRevenue & margin",
    });
  });
});
