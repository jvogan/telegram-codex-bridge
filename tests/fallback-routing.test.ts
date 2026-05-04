import { describe, expect, test } from "vitest";

import {
  isFallbackEligibleTelegramTask,
  selectTelegramTaskLane,
} from "../src/core/telegram/fallback-routing.js";

const enabledPolicy = {
  enabled: true,
  allowWorkspaceWrites: false,
};

describe("fallback routing", () => {
  test("routes safe text work to fallback only when the desktop turn is verified busy", () => {
    const task = { kind: "text" as const, text: "Summarize the PDF I sent and give me the key risks." };

    expect(selectTelegramTaskLane({
      task,
      holdReason: null,
      policy: enabledPolicy,
    })).toBe("primary");

    expect(selectTelegramTaskLane({
      task,
      holdReason: "desktop_turn_active",
      policy: enabledPolicy,
    })).toBe("fallback");
  });

  test("keeps unsafe or mutating prompts on the primary lane", () => {
    const task = { kind: "text" as const, text: "Implement this in the repo and commit it." };

    expect(isFallbackEligibleTelegramTask(task, enabledPolicy)).toBe(false);
    expect(selectTelegramTaskLane({
      task,
      holdReason: "desktop_turn_active",
      policy: enabledPolicy,
    })).toBe("primary");

    for (const text of [
      "Take a screenshot of the desktop.",
      "Open the browser and click the settings button.",
      "Run npm test in the terminal.",
      "Write this file into the workspace.",
      "Print my API token.",
    ]) {
      expect(isFallbackEligibleTelegramTask({ kind: "text", text }, enabledPolicy)).toBe(false);
    }
  });

  test("keeps bound-session requests on the primary lane", () => {
    for (const text of [
      "Tell the bound session to code review for security then update here.",
      "Ask this desktop Codex session to inspect the PR and report back here.",
      "Have the agent type hello in its session.",
    ]) {
      expect(isFallbackEligibleTelegramTask({ kind: "text", text }, enabledPolicy)).toBe(false);
      expect(selectTelegramTaskLane({
        task: { kind: "text", text },
        holdReason: "desktop_turn_active",
        policy: enabledPolicy,
      })).toBe("primary");
    }
  });

  test("requires explicit fallback policy enablement", () => {
    expect(selectTelegramTaskLane({
      task: { kind: "image" as const, text: "What is in this photo?" },
      holdReason: "desktop_turn_active",
      policy: {
        enabled: false,
        allowWorkspaceWrites: false,
      },
    })).toBe("primary");
  });

  test("workspace-write fallback policy still blocks hard side effects", () => {
    const writePolicy = {
      enabled: true,
      allowWorkspaceWrites: true,
    };

    expect(isFallbackEligibleTelegramTask({ kind: "text", text: "Fix the typo in README." }, writePolicy)).toBe(true);
    for (const text of [
      "Deploy this branch.",
      "Run git push.",
      "Use the terminal shell.",
    ]) {
      expect(isFallbackEligibleTelegramTask({ kind: "text", text }, writePolicy)).toBe(false);
    }
  });
});
