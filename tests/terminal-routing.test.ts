import { describe, expect, test } from "vitest";

import {
  buildTerminalConversationPromptForText,
  buildTerminalConversationPromptForTask,
  buildTerminalExplicitPromptForText,
  buildTerminalPromptForTask,
  buildTerminalPromptForText,
  isTerminalHardBlockedRequest,
  isTerminalUnsafeRequest,
  isTerminalWorkspaceMutationRequest,
  selectTerminalRouteForTask,
  terminalConversationBlocker,
  terminalExplicitAskBlocker,
  terminalRequestTextForTask,
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

function voiceTask(transcriptText?: string, text = "(voice message)"): QueuedTelegramTask {
  const task: QueuedTelegramTask = {
    ...textTask(text),
    kind: "voice",
    mediaFileId: "voice-1",
    mediaMimeType: "audio/ogg",
  };
  if (transcriptText !== undefined) {
    task.transcriptText = transcriptText;
  }
  return task;
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
    expect(selectTerminalRouteForTask(textTask("search the web for a related paper"), {
      desktopBusy: false,
      terminalConversationMode: true,
    })).toEqual({
      route: "terminal",
      reason: "terminal_chat_mode",
    });
  });

  test("terminal chat mode routes transcribed voice like normal text", () => {
    expect(selectTerminalRouteForTask(voiceTask(undefined), {
      desktopBusy: false,
      terminalConversationMode: true,
    })).toEqual({
      route: "primary",
      reason: "desktop_not_busy",
    });
    expect(selectTerminalRouteForTask(voiceTask("What failed, the audio or something else?"), {
      desktopBusy: false,
      terminalConversationMode: true,
    })).toEqual({
      route: "terminal",
      reason: "terminal_chat_mode",
    });
    expect(selectTerminalRouteForTask(voiceTask("Use the native image generation tool and generate it again."), {
      desktopBusy: false,
      terminalConversationMode: true,
    })).toEqual({
      route: "primary",
      reason: "terminal_chat_primary_bridge_request",
    });
  });

  test("terminal prompts use the transcript instead of the Telegram voice placeholder", () => {
    const task = voiceTask("List the top-level files and do not edit files.");
    expect(terminalRequestTextForTask(task)).toBe("List the top-level files and do not edit files.");
    const prompt = buildTerminalConversationPromptForTask(task, { allowWorkspaceWrites: true });
    expect(prompt).toContain("User request: List the top-level files and do not edit files.");
    expect(prompt).not.toContain("User request: (voice message)");
  });

  test("routes safe web and paper research to terminal when desktop is busy", () => {
    expect(selectTerminalRouteForTask(textTask("search the web for a recent paper on terminal lanes"), {
      desktopBusy: true,
    })).toEqual({
      route: "terminal",
      reason: "readonly_local_or_repo_request_desktop_busy",
    });
    expect(selectTerminalRouteForTask(textTask("find a source online about codex terminal lanes"), {
      desktopBusy: true,
    })).toEqual({
      route: "terminal",
      reason: "readonly_local_or_repo_request_desktop_busy",
    });
    expect(selectTerminalRouteForTask(textTask("show figure 1 from the newest paper in Downloads"), {
      desktopBusy: true,
    })).toEqual({
      route: "primary",
      reason: "primary_bridge_request",
    });
  });

  test("terminal chat mode distinguishes workspace writes from hard blocks", () => {
    expect(isTerminalWorkspaceMutationRequest("fix the bug in the repo")).toBe(true);
    expect(terminalConversationBlocker("fix the bug in the repo", { allowWorkspaceWrites: false })).toContain("read-only");
    expect(terminalConversationBlocker("fix the bug in the repo", { allowWorkspaceWrites: true })).toBeNull();
    expect(isTerminalHardBlockedRequest("deploy this and print my API key")).toBe(true);
    expect(isTerminalHardBlockedRequest("pull together a summary of the repo")).toBe(false);
    expect(isTerminalUnsafeRequest("draw conclusions from this paper")).toBe(false);
    expect(isTerminalUnsafeRequest("draw a diagram of the bridge")).toBe(true);
    expect(terminalConversationBlocker("deploy this and print my API key", { allowWorkspaceWrites: true })).toContain("blocks");
    expect(terminalConversationBlocker("make an image of a terminal lane", { allowWorkspaceWrites: true })).toContain("bound desktop bridge path");
  });

  test("explicit terminal asks honor power-user workspace writes without allowing hard blocks", () => {
    expect(terminalExplicitAskBlocker("fix the typo in README", { allowWorkspaceWrites: false })).toContain("read-only");
    expect(terminalExplicitAskBlocker("fix the typo in README", { allowWorkspaceWrites: true })).toBeNull();
    expect(terminalExplicitAskBlocker("deploy this branch", { allowWorkspaceWrites: true })).toContain("blocks");
    expect(terminalExplicitAskBlocker("make an image of a bridge", { allowWorkspaceWrites: true })).toContain("bound desktop bridge path");

    const powerPrompt = buildTerminalExplicitPromptForText("fix the typo in README", { allowWorkspaceWrites: true });
    expect(powerPrompt).toContain("explicit terminal Codex lane task");
    expect(powerPrompt).toContain("workspace-write sandbox");
    expect(powerPrompt).toContain("User request: fix the typo in README");
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
