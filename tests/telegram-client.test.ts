import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test, vi } from "vitest";

import type { Logger } from "../src/core/logger.js";
import { TelegramClient } from "../src/core/telegram/client.js";

const logger: Logger = {
  info() {},
  warn() {},
  error() {},
};

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();
    if (root) {
      rmSync(root, { recursive: true, force: true });
    }
  }
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("TelegramClient.editMessageText", () => {
  test("treats 'message is not modified' as a benign no-op", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        ok: false,
        error_code: 400,
        description: "Bad Request: message is not modified",
      }),
      {
        status: 400,
        headers: {
          "content-type": "application/json",
        },
      },
    )));

    const client = new TelegramClient("test-token", logger);

    await expect(client.editMessageText("123", 456, "same text")).resolves.toBeUndefined();
  });

  test("still throws other Telegram edit errors with details", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        ok: false,
        error_code: 400,
        description: "Bad Request: message to edit not found",
      }),
      {
        status: 400,
        headers: {
          "content-type": "application/json",
        },
      },
    )));

    const client = new TelegramClient("test-token", logger);

    await expect(client.editMessageText("123", 456, "same text")).rejects.toThrow("message to edit not found");
  });
});

describe("TelegramClient.getUpdates", () => {
  test("includes Telegram error descriptions on non-200 polling failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        ok: false,
        error_code: 409,
        description: "Conflict: terminated by other getUpdates request",
      }),
      {
        status: 409,
        headers: {
          "content-type": "application/json",
        },
      },
    )));

    const client = new TelegramClient("test-token", logger);

    await expect(client.getUpdates(1, 30, 25)).rejects.toThrow("terminated by other getUpdates request");
  });

  test("uses a bounded fetch signal for long polling", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramClient("test-token", logger);

    await expect(client.getUpdates(1, 1, 25)).resolves.toEqual([]);
  });

  test("retries transient polling network errors", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramClient("test-token", logger);

    await expect(client.getUpdates(1, 1, 25)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("retries transient polling server errors", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: false, description: "Bad Gateway" }),
        { status: 502, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, result: [] }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramClient("test-token", logger);

    await expect(client.getUpdates(1, 1, 25)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("TelegramClient.sendMessage", () => {
  test("uses a bounded fetch signal for outbound messages", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramClient("test-token", logger);

    await expect(client.sendMessage("123", "hello")).resolves.toEqual({ message_id: 42 });
  });

  test("retries transient Telegram server errors for outbound messages", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: false, description: "Bad Gateway" }),
        { status: 502, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: true, result: { message_id: 43 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramClient("test-token", logger);

    await expect(client.sendMessage("123", "hello")).resolves.toEqual({ message_id: 43 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("honors retryable rate-limit responses for outbound messages", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          ok: false,
          description: "Too Many Requests",
          parameters: { retry_after: 1 },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({ ok: true, result: { message_id: 44 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      ));
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramClient("test-token", logger);

    await expect(client.sendMessage("123", "hello")).resolves.toEqual({ message_id: 44 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("TelegramClient.sendChatAction", () => {
  test("sends a bounded non-retried chat action request", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      expect(JSON.parse(String(init?.body))).toEqual({
        chat_id: "123",
        action: "typing",
      });
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new TelegramClient("test-token", logger);

    await expect(client.sendChatAction("123", "typing")).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("/sendChatAction");
  });
});

describe("TelegramClient.downloadFile", () => {
  test("rejects oversized files before download when Telegram reports file_size", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({
        ok: true,
        result: {
          file_id: "file-1",
          file_path: "documents/report.pdf",
          file_size: 1024,
        },
      }),
      {
        status: 200,
        headers: {
          "content-type": "application/json",
        },
      },
    )));

    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-client-"));
    tempRoots.push(root);
    const client = new TelegramClient("test-token", logger);

    await expect(client.downloadFile("file-1", join(root, "report.pdf"), { maxBytes: 512 })).rejects.toThrow("too large");
  });

  test("aborts downloads that exceed the streaming byte limit when metadata is missing", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(
        JSON.stringify({
          ok: true,
          result: {
            file_id: "file-2",
            file_path: "documents/report.pdf",
          },
        }),
        {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        },
      ))
      .mockResolvedValueOnce(new Response("1234567890", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const root = mkdtempSync(join(tmpdir(), "telegram-codex-bridge-client-"));
    tempRoots.push(root);
    const client = new TelegramClient("test-token", logger);

    await expect(client.downloadFile("file-2", join(root, "report.pdf"), { maxBytes: 4 })).rejects.toThrow("exceeded");
  });
});
