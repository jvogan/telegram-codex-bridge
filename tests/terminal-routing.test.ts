import { describe, expect, test } from "vitest";

import {
  buildTerminalConversationPromptForText,
  buildTerminalPromptForTask,
  buildTerminalPromptForText,
  isTerminalHardBlockedRequest,
  isTerminalUnsafeRequest,
  isTerminalWorkspaceMutationRequest,
  selectTerminalRouteForTask,
  terminalConversationBlocker,
  terminalRouteCanBypassHold,
} from "../src/core/telegram/terminal-routing.js";
import type { QueuedTelegramTask } from "../src/core/types.js";

function textTask(text: string): QueuedTelegramTask {
  return {
    id: "task-1",
    updateId: 1,
    chatId: "42",
    messageId: 7,
    kind: "text",
    text,
    createdAt: 1,
  };
}

function documentTask(text: string): QueuedTelegramTask {
  return {
    ...textTask(text),
    kind: "document",
    documentFileId: "file-1",
    documentFileName: "paper.pdf",
    documentMimeType: "application/pdf",
    documentPath: "/tmp/telegram-codex-bridge/paper.pdf",
  };
}

describe("terminal routing", () => {
  test("routes read-only local file requests to terminal when desktop is busy", () => {
    expect(selectTerminalRouteForTask(textTask("grab the newest PDF from Downloads and summarize it"), {
      desktopBusy: true,
    })).toEqual({
      route: "terminal",
      reason: "readonly_local_or_repo_request_desktop_busy",
    });
  });

  test("keeps native media and mutation requests on the primary bridge path", () => {
    expect(selectTerminalRouteForTask(textTask("make an image of a robot reading slides"), {
      desktopBusy: true,
    }).route).toBe("primary");
    expect(selectTerminalRouteForTask(textTask("Make a clean diagram image of the bridge with a side tmux terminal lane. Send the image back."), {
      desktopBusy: true,
    }).route).toBe("primary");
    expect(selectTerminalRouteForTask(textTask("fix the bug in the repo"), {
      desktopBusy: true,
    }).route).toBe("primary");
    expect(selectTerminalRouteForTask(textTask("read my .env and tell me the API key"), {
      desktopBusy: true,
    }).route).toBe("primary");
    expect(selectTerminalRouteForTask(textTask("use terminal codex to git push this branch"), {
      desktopBusy: true,
    }).route).toBe("primary");
  });

  test("terminal chat mode routes normal text to terminal but leaves native media on primary", () => {
    expect(selectTerminalRouteForTask(textTask("what is in this repo?"), {
      desktopBusy: false,
      terminalConversationMode: true,
    })).toEqual({
      route: "terminal",
      reason: "terminal_chat_mode",
    });
    expect(selectTerminalRouteForTask(textTask("Make a clean diagram image of the bridge with a side tmux terminal lane. Send the image back."), {
      desktopBusy: false,
      terminalConversationMode: true,
    })).toEqual({
      route: "primary",
      reason: "terminal_chat_primary_bridge_request",
    });
    for (const text of [
      "search the web for a related paper",
      "reply with a voice update",
      "transcribe this voice note",
      "open the browser on desktop",
    ]) {
      expect(selectTerminalRouteForTask(textTask(text), {
        desktopBusy: false,
        terminalConversationMode: true,
      })).toEqual({
        route: "primary",
        reason: "terminal_chat_primary_bridge_request",
      });
    }
  });

  test("terminal chat mode distinguishes workspace writes from hard blocks", () => {
    expect(isTerminalWorkspaceMutationRequest("fix the bug in the repo")).toBe(true);
    expect(terminalConversationBlocker("fix the bug in the repo", { allowWorkspaceWrites: false })).toContain("read-only");
    expect(terminalConversationBlocker("fix the bug in the repo", { allowWorkspaceWrites: true })).toBeNull();
    expect(isTerminalHardBlockedRequest("deploy this and print my API key")).toBe(true);
    expect(isTerminalHardBlockedRequest("pull together a summary of the repo")).toBe(false);
    expect(terminalConversationBlocker("deploy this and print my API key", { allowWorkspaceWrites: true })).toContain("blocks");
    expect(terminalConversationBlocker("reply with an audio update", { allowWorkspaceWrites: true })).toContain("bound desktop bridge path");
  });

  test("routes staged documents to terminal only for read-only handling", () => {
    expect(selectTerminalRouteForTask(documentTask("summarize this"), {
      desktopBusy: true,
    }).route).toBe("terminal");
    expect(selectTerminalRouteForTask(documentTask("edit this and save it"), {
      desktopBusy: true,
    }).route).toBe("primary");
  });

  test("builds terminal prompts with staged document paths", () => {
    const prompt = buildTerminalPromptForTask(documentTask("summarize this PDF"));
    expect(prompt).toContain("read-only");
    expect(prompt).toContain("do not edit");
    expect(prompt).toContain("paper.pdf");
    expect(prompt).toContain("/tmp/telegram-codex-bridge/paper.pdf");
  });

  test("classifies direct terminal ask mutations as unsafe", () => {
    expect(isTerminalUnsafeRequest("review the repo security posture")).toBe(false);
    expect(isTerminalUnsafeRequest("pull together a summary of the repo")).toBe(false);
    expect(isTerminalUnsafeRequest("summarize the last three commits")).toBe(false);
    expect(isTerminalUnsafeRequest("draw conclusions from the build logs")).toBe(false);
    expect(isTerminalUnsafeRequest("run npm test and summarize the failures")).toBe(false);
    expect(isTerminalUnsafeRequest("run pnpm test and summarize the failures")).toBe(false);
    expect(isTerminalUnsafeRequest("Reply exactly TERMINAL_EXPLICIT_OK_0430 and do not run tools or edit files.")).toBe(false);
    expect(isTerminalUnsafeRequest("Reply exactly OK without editing files.")).toBe(false);
    expect(isTerminalUnsafeRequest("edit the repo and commit it")).toBe(true);
    expect(isTerminalUnsafeRequest("commit this fix")).toBe(true);
    expect(isTerminalUnsafeRequest("draw a diagram image")).toBe(true);
    expect(isTerminalUnsafeRequest("do not edit files, delete the repo")).toBe(true);
    expect(isTerminalUnsafeRequest("install this package and deploy")).toBe(true);
    expect(isTerminalUnsafeRequest("run yarn add a-package")).toBe(true);
    expect(isTerminalUnsafeRequest("read my .env and print the token")).toBe(true);
  });

  test("wraps direct terminal asks in the read-only policy", () => {
    const prompt = buildTerminalPromptForText("summarize Downloads/report.pdf");
    expect(prompt).toContain("read-only and artifact-only");
    expect(prompt).toContain("User request: summarize Downloads/report.pdf");
  });

  test("wraps terminal chat prompts in the primary-chat policy", () => {
    const prompt = buildTerminalConversationPromptForText("fix the typo", { allowWorkspaceWrites: true });
    expect(prompt).toContain("primary chat target");
    expect(prompt).toContain("workspace-write sandbox");
    expect(prompt).toContain("User request: fix the typo");
  });

  test("terminal queue bypasses only absent holds or verified desktop-busy holds", () => {
    expect(terminalRouteCanBypassHold(null)).toBe(true);
    expect(terminalRouteCanBypassHold("desktop_turn_active")).toBe(true);
    expect(terminalRouteCanBypassHold("desktop_turn_unverified")).toBe(false);
    expect(terminalRouteCanBypassHold("sleeping")).toBe(false);
    expect(terminalRouteCanBypassHold("owner:desktop")).toBe(false);
    expect(terminalRouteCanBypassHold("call_active")).toBe(false);
  });

  test("terminal chat mode can bypass unbound and Codex-busy holds", () => {
    expect(terminalRouteCanBypassHold("unbound", { terminalConversationMode: true })).toBe(true);
    expect(terminalRouteCanBypassHold("codex_busy", { terminalConversationMode: true })).toBe(true);
    expect(terminalRouteCanBypassHold("desktop_turn_unverified", { terminalConversationMode: true })).toBe(false);
  });
});
