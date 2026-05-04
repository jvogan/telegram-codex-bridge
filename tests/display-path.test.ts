import { describe, expect, test } from "vitest";

import { formatDisplayPath } from "../src/core/util/display-path.js";

describe("formatDisplayPath", () => {
  test("leaves paths unchanged outside demo practice mode", () => {
    const path = "/tmp/demo-workspace/artifacts/report.pdf";

    expect(formatDisplayPath(path)).toBe(path);
  });

  test("shows only the basename for absolute paths in demo practice mode", () => {
    expect(formatDisplayPath("/tmp/demo-workspace/artifacts/report.pdf", {
      demoPracticeMode: true,
    })).toBe("report.pdf");
    expect(formatDisplayPath("C:\\workspace\\artifacts\\report.pdf", {
      demoPracticeMode: true,
    })).toBe("report.pdf");
  });

  test("preserves relative paths in demo practice mode", () => {
    expect(formatDisplayPath("artifacts/report.pdf", {
      demoPracticeMode: true,
    })).toBe("artifacts/report.pdf");
  });

  test("uses a caller-provided empty label", () => {
    expect(formatDisplayPath("   ", {
      emptyLabel: "(none)",
    })).toBe("(none)");
  });
});
