import { createWriteStream, openAsBlob } from "node:fs";
import { mkdir, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type { Logger } from "../logger.js";
import type { TelegramBotIdentity, TelegramCallbackQuery, TelegramFileResult, TelegramUpdate, TelegramWebhookInfo } from "./types.js";

interface TelegramEnvelope<T> {
  ok: boolean;
  result: T;
  description?: string;
  error_code?: number;
  parameters?: {
    retry_after?: number;
  };
}

const TELEGRAM_JSON_REQUEST_TIMEOUT_MS = 30_000;
const TELEGRAM_UPLOAD_REQUEST_TIMEOUT_MS = 120_000;
const TELEGRAM_DOWNLOAD_TIMEOUT_MS = 60_000;
const TELEGRAM_LONG_POLL_GRACE_MS = 15_000;
const TELEGRAM_RETRY_ATTEMPTS = 3;
const TELEGRAM_RETRY_BASE_DELAY_MS = 250;
const TELEGRAM_RETRY_MAX_DELAY_MS = 2_000;

export class TelegramClient {
  constructor(
    private readonly token: string,
    private readonly logger: Logger,
  ) {}

  private parseEnvelope<T>(raw: string): TelegramEnvelope<T> | null {
    try {
      return raw ? JSON.parse(raw) as TelegramEnvelope<T> : null;
    } catch {
      return null;
    }
  }

  private apiUrl(method: string): string {
    return `https://api.telegram.org/bot${this.token}/${method}`;
  }

  private fileUrl(filePath: string): string {
    return `https://api.telegram.org/file/bot${this.token}/${filePath}`;
  }

  private signalWithTimeout(timeoutMs: number, signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private retryDelayMs(status: number | null, payload: TelegramEnvelope<unknown> | null, attempt: number): number | null {
    if (status !== null && status !== 429 && status < 500) {
      return null;
    }
    const retryAfterMs = payload?.parameters?.retry_after
      ? Math.min(payload.parameters.retry_after * 1000, TELEGRAM_RETRY_MAX_DELAY_MS)
      : null;
    return retryAfterMs ?? Math.min(TELEGRAM_RETRY_BASE_DELAY_MS * (attempt + 1), TELEGRAM_RETRY_MAX_DELAY_MS);
  }

  private async callApi<T>(
    method: string,
    buildInit: () => RequestInit,
    options: { timeoutMs: number; retry?: boolean; signal?: AbortSignal },
  ): Promise<T> {
    const attempts = options.retry === false ? 1 : TELEGRAM_RETRY_ATTEMPTS;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await fetch(this.apiUrl(method), {
          ...buildInit(),
          signal: this.signalWithTimeout(options.timeoutMs, options.signal),
        });
        const raw = await response.text();
        const payload = this.parseEnvelope<T>(raw);
        if (response.ok && payload?.ok) {
          return payload.result;
        }
        const details = payload?.description ?? raw;
        const error = response.ok
          ? new Error(`Telegram ${method} returned ok=false${details ? `: ${details}` : ""}`)
          : new Error(`Telegram ${method} failed with HTTP ${response.status}${details ? `: ${details}` : ""}`);
        const delayMs = this.retryDelayMs(response.status, payload, attempt);
        if (attempt < attempts - 1 && delayMs !== null) {
          this.logger.warn("retrying Telegram API request", {
            method,
            attempt: attempt + 1,
            status: response.status,
            delayMs,
          });
          await sleep(delayMs);
          continue;
        }
        lastError = error;
        break;
      } catch (error) {
        lastError = error;
        if (options.signal?.aborted) {
          break;
        }
        if (attempt < attempts - 1) {
          const delayMs = this.retryDelayMs(null, null, attempt) ?? TELEGRAM_RETRY_BASE_DELAY_MS;
          this.logger.warn("retrying Telegram API request after network error", {
            method,
            attempt: attempt + 1,
            delayMs,
            error: error instanceof Error ? error.message : String(error),
          });
          await sleep(delayMs);
          continue;
        }
        break;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Telegram API request failed"));
  }

  private async callJson<T>(method: string, body: Record<string, unknown>, options: { timeoutMs?: number; retry?: boolean } = {}): Promise<T> {
    return this.callApi<T>(method, () => ({
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }), {
      timeoutMs: options.timeoutMs ?? TELEGRAM_JSON_REQUEST_TIMEOUT_MS,
      ...(options.retry !== undefined ? { retry: options.retry } : {}),
    });
  }

  private async callForm<T>(method: string, form: FormData, options: { timeoutMs?: number; retry?: boolean } = {}): Promise<T> {
    return this.callApi<T>(method, () => ({
      method: "POST",
      body: form,
    }), {
      timeoutMs: options.timeoutMs ?? TELEGRAM_UPLOAD_REQUEST_TIMEOUT_MS,
      ...(options.retry !== undefined ? { retry: options.retry } : {}),
    });
  }

  async getUpdates(offset: number, timeoutSeconds: number, limit: number, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    return this.callApi<TelegramUpdate[]>("getUpdates", () => ({
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        offset,
        timeout: timeoutSeconds,
        limit,
        allowed_updates: ["message", "callback_query"],
      }),
    }), {
      timeoutMs: Math.max(1_000, (timeoutSeconds * 1000) + TELEGRAM_LONG_POLL_GRACE_MS),
      ...(signal ? { signal } : {}),
    });
  }

  async getMe(): Promise<TelegramBotIdentity> {
    return this.callJson("getMe", {});
  }

  async getWebhookInfo(): Promise<TelegramWebhookInfo> {
    return this.callJson("getWebhookInfo", {});
  }

  async deleteWebhook(dropPendingUpdates = false): Promise<void> {
    await this.callJson("deleteWebhook", {
      drop_pending_updates: dropPendingUpdates,
    });
  }

  async setMyName(name: string): Promise<void> {
    await this.callJson("setMyName", { name });
  }

  async setMyDescription(description: string): Promise<void> {
    await this.callJson("setMyDescription", { description });
  }

  async setMyShortDescription(shortDescription: string): Promise<void> {
    await this.callJson("setMyShortDescription", { short_description: shortDescription });
  }

  async setMyCommands(commands: Array<{ command: string; description: string }>): Promise<void> {
    await this.callJson("setMyCommands", { commands });
  }

  async sendMessage(chatId: string, text: string, options?: { replyMarkup?: Record<string, unknown>; replyToMessageId?: number }): Promise<{ message_id: number }> {
    return this.callJson("sendMessage", {
      chat_id: chatId,
      text,
      reply_markup: options?.replyMarkup,
      reply_to_message_id: options?.replyToMessageId,
    });
  }

  async editMessageText(chatId: string, messageId: number, text: string, options?: { replyMarkup?: Record<string, unknown> }): Promise<void> {
    try {
      await this.callJson("editMessageText", {
        chat_id: chatId,
        message_id: messageId,
        text,
        reply_markup: options?.replyMarkup,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("message is not modified")) {
        return;
      }
      throw error;
    }
  }

  async sendChatAction(
    chatId: string,
    action: "typing" | "upload_photo" | "record_voice" | "upload_voice" | "upload_document" | "upload_video",
  ): Promise<void> {
    await this.callJson("sendChatAction", {
      chat_id: chatId,
      action,
    }, { retry: false });
  }

  async sendVoice(chatId: string, filePath: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("voice", await openAsBlob(filePath), filePath.split("/").pop() ?? "reply.ogg");
    if (caption) {
      form.set("caption", caption);
    }
    await this.callForm("sendVoice", form);
  }

  async sendPhoto(chatId: string, filePath: string, caption?: string): Promise<void> {
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("photo", await openAsBlob(filePath), filePath.split("/").pop() ?? "image.png");
    if (caption) {
      form.set("caption", caption);
    }
    await this.callForm("sendPhoto", form);
  }

  async sendDocument(chatId: string, filePath: string, caption?: string, fileName?: string): Promise<void> {
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("document", await openAsBlob(filePath), fileName ?? filePath.split("/").pop() ?? "artifact.bin");
    if (caption) {
      form.set("caption", caption);
    }
    await this.callForm("sendDocument", form);
  }

  async sendVideo(chatId: string, filePath: string, caption?: string, fileName?: string): Promise<void> {
    const form = new FormData();
    form.set("chat_id", chatId);
    form.set("video", await openAsBlob(filePath), fileName ?? filePath.split("/").pop() ?? "video.mp4");
    if (caption) {
      form.set("caption", caption);
    }
    await this.callForm("sendVideo", form);
  }

  async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    await this.callJson("answerCallbackQuery", {
      callback_query_id: callbackQueryId,
      ...(text ? { text } : {}),
    });
  }

  async getFile(fileId: string): Promise<TelegramFileResult> {
    return this.callJson("getFile", { file_id: fileId });
  }

  async downloadFile(fileId: string, destinationPath: string, options?: { maxBytes?: number; timeoutMs?: number }): Promise<string> {
    const file = await this.getFile(fileId);
    if (!file.file_path) {
      throw new Error(`Telegram file ${fileId} had no file_path`);
    }
    if (options?.maxBytes && typeof file.file_size === "number" && file.file_size > options.maxBytes) {
      throw new Error(`Telegram file ${fileId} is too large (${file.file_size} bytes > ${options.maxBytes} byte limit).`);
    }
    await mkdir(dirname(destinationPath), { recursive: true, mode: 0o700 });
    const response = await fetch(this.fileUrl(file.file_path), {
      signal: this.signalWithTimeout(options?.timeoutMs ?? TELEGRAM_DOWNLOAD_TIMEOUT_MS),
    });
    if (!response.ok || !response.body) {
      throw new Error(`Telegram file download failed with HTTP ${response.status}`);
    }
    const tempPath = `${destinationPath}.download`;
    let streamedBytes = 0;
    const sizeLimiter = new Transform({
      transform: (chunk, _encoding, callback) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        streamedBytes += buffer.length;
        if (options?.maxBytes && streamedBytes > options.maxBytes) {
          callback(new Error(`Telegram file ${fileId} exceeded the ${options.maxBytes}-byte download limit.`));
          return;
        }
        callback(null, buffer);
      },
    });
    try {
      await pipeline(
        Readable.fromWeb(response.body as any),
        sizeLimiter,
        createWriteStream(tempPath, { mode: 0o600 }),
      );
      await rename(tempPath, destinationPath);
      return destinationPath;
    } catch (error) {
      await unlink(tempPath).catch(() => undefined);
      throw error;
    }
  }

  approvalKeyboard(localId: string, method: string): Record<string, unknown> {
    const buttons: Array<Array<{ text: string; callback_data: string }>> = [];
    if (method === "item/permissions/requestApproval") {
      buttons.push([
        { text: "Approve Turn", callback_data: `apr:${localId}:turn` },
        { text: "Approve Session", callback_data: `apr:${localId}:session` },
      ]);
      buttons.push([
        { text: "Deny", callback_data: `apr:${localId}:deny` },
        { text: "Cancel Turn", callback_data: `apr:${localId}:cancel` },
      ]);
    } else {
      buttons.push([
        { text: "Approve Once", callback_data: `apr:${localId}:accept` },
        { text: "Approve Session", callback_data: `apr:${localId}:acceptSession` },
      ]);
      buttons.push([
        { text: "Deny", callback_data: `apr:${localId}:deny` },
        { text: "Cancel Turn", callback_data: `apr:${localId}:cancel` },
      ]);
    }
    return {
      inline_keyboard: buttons,
    };
  }

  static parseApprovalCallback(callbackQuery: TelegramCallbackQuery): { localId: string; action: string } | null {
    const data = callbackQuery.data;
    if (!data || !data.startsWith("apr:")) {
      return null;
    }
    const [, localId, action] = data.split(":");
    if (!localId || !action) {
      return null;
    }
    return { localId, action };
  }
}
