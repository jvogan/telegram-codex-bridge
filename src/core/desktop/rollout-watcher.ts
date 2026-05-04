import { open, readFile, stat } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

import type { TurnResult } from "../codex/protocol.js";

interface ParsedLine {
  timestampMs: number;
  type: string;
  payload: any;
}

export interface RolloutInspection {
  hasActivity: boolean;
  result: TurnResult | null;
}

export interface ThreadActivity {
  activeTurnId: string | null;
  activeTurnIds: string[];
  lastStartedAt: number | null;
  lastCompletedAt: number | null;
}

interface TurnMatchOptions {
  expectedTurnId?: string | null;
  signal?: AbortSignal;
  pollMs?: number;
}

interface RolloutCache {
  rolloutPath: string;
  size: number;
  mtimeMs: number;
  events: ParsedLine[];
  tail: string;
}

const ROLLOUT_ACTIVE_TURN_STALE_MS = 30 * 60 * 1000;

function parseLine(raw: string): ParsedLine | null {
  const line = raw.trim();
  if (!line) {
    return null;
  }
  try {
    const parsed = JSON.parse(line) as { timestamp?: string; type?: string; payload?: any };
    if (!parsed.timestamp || !parsed.type) {
      return null;
    }
    return {
      timestampMs: Date.parse(parsed.timestamp),
      type: parsed.type,
      payload: parsed.payload ?? null,
    };
  } catch {
    return null;
  }
}

function parseChunk(raw: string): { events: ParsedLine[]; tail: string } {
  const events: ParsedLine[] = [];
  const lines = raw.split("\n");
  const endsWithNewline = raw.endsWith("\n");
  let tail = "";

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const isLast = index === lines.length - 1;
    if (isLast && !endsWithNewline) {
      const parsed = parseLine(line);
      if (parsed) {
        events.push(parsed);
      } else if (line.trim()) {
        tail = line;
      }
      continue;
    }
    const parsed = parseLine(line);
    if (parsed) {
      events.push(parsed);
    }
  }

  return { events, tail };
}

async function readFileSlice(path: string, start: number, length: number): Promise<string> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, start + offset);
      if (bytesRead === 0) {
        break;
      }
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

function extractTurnResult(events: ParsedLine[], startedAfter: number, options: TurnMatchOptions = {}): TurnResult | null {
  const relevant = events.filter(event => event.timestampMs >= startedAfter - 1000);
  const finalMessages: string[] = [];
  let fallbackMessage = "";
  let completedAt: number | null = null;
  let turnId = "";
  const expectedTurnId = options.expectedTurnId ?? null;
  let matchedExpectedCompletionText = "";

  for (const event of relevant) {
    if (event.type === "event_msg" && event.payload?.type === "agent_message" && typeof event.payload.message === "string") {
      if (!expectedTurnId) {
        fallbackMessage = event.payload.message;
        if (event.payload.phase === "final_answer") {
          finalMessages.push(event.payload.message);
        }
      }
      continue;
    }
    if (event.type === "response_item" && event.payload?.type === "message" && event.payload?.role === "assistant") {
      const text = event.payload.content
        ?.filter((entry: any) => entry.type === "output_text" && typeof entry.text === "string")
        ?.map((entry: any) => entry.text)
        ?.join("\n") ?? "";
      if (text && !expectedTurnId) {
        fallbackMessage = text;
        if (event.payload.phase === "final_answer") {
          finalMessages.push(text);
        }
      }
      continue;
    }
    if (event.type === "event_msg" && event.payload?.type === "task_complete") {
      const completedTurnId = String(event.payload.turn_id ?? "");
      if (expectedTurnId && completedTurnId !== expectedTurnId) {
        continue;
      }
      completedAt = event.timestampMs;
      turnId = completedTurnId;
      if (typeof event.payload.last_agent_message === "string" && event.payload.last_agent_message) {
        if (expectedTurnId) {
          matchedExpectedCompletionText = event.payload.last_agent_message;
        } else {
          fallbackMessage = event.payload.last_agent_message;
        }
      }
    }
  }

  if (!completedAt) {
    return null;
  }
  if (expectedTurnId && !matchedExpectedCompletionText) {
    return null;
  }
  return {
    turnId: turnId || `rollout-${completedAt}`,
    startedAt: startedAfter,
    completedAt,
    finalText: expectedTurnId
      ? matchedExpectedCompletionText
      : (finalMessages.length > 0 ? finalMessages.join("\n\n") : fallbackMessage),
  };
}

function inspectEvents(events: ParsedLine[], startedAfter: number, options: TurnMatchOptions = {}): RolloutInspection {
  const relevant = events.filter(event => event.timestampMs >= startedAfter - 1000);
  return {
    hasActivity: relevant.length > 0,
    result: extractTurnResult(events, startedAfter, options),
  };
}

function inspectThreadActivity(events: ParsedLine[], nowMs = Date.now()): ThreadActivity {
  const activeTurnIds: string[] = [];
  const activeTurnLastSeen = new Map<string, number>();
  let lastStartedAt: number | null = null;
  let lastCompletedAt: number | null = null;
  let latestEventAt: number | null = null;

  for (const event of events) {
    latestEventAt = event.timestampMs;
    const eventTurnId = typeof event.payload?.turn_id === "string" ? event.payload.turn_id : null;
    if (eventTurnId && activeTurnLastSeen.has(eventTurnId)) {
      activeTurnLastSeen.set(eventTurnId, event.timestampMs);
    }
    if (event.type !== "event_msg") {
      continue;
    }
    if (event.payload?.type === "task_started") {
      const turnId = eventTurnId;
      if (turnId) {
        const existingIndex = activeTurnIds.indexOf(turnId);
        if (existingIndex >= 0) {
          activeTurnIds.splice(existingIndex, 1);
        }
        activeTurnIds.push(turnId);
        activeTurnLastSeen.set(turnId, event.timestampMs);
      }
      lastStartedAt = event.timestampMs;
      continue;
    }
    if (event.payload?.type === "task_complete") {
      const turnId = eventTurnId;
      if (turnId) {
        const existingIndex = activeTurnIds.indexOf(turnId);
        if (existingIndex >= 0) {
          activeTurnIds.splice(existingIndex, 1);
        }
        activeTurnLastSeen.delete(turnId);
      } else {
        const popped = activeTurnIds.pop();
        if (popped) {
          activeTurnLastSeen.delete(popped);
        }
      }
      lastCompletedAt = event.timestampMs;
    }
  }

  const referenceTimeMs = latestEventAt === null
    ? nowMs
    : Math.max(nowMs, latestEventAt);
  const freshActiveTurnIds = latestEventAt === null
    ? []
    : activeTurnIds.filter(turnId => {
      const lastSeen = activeTurnLastSeen.get(turnId);
      return typeof lastSeen === "number"
        && referenceTimeMs - lastSeen <= ROLLOUT_ACTIVE_TURN_STALE_MS;
    });

  return {
    activeTurnId: freshActiveTurnIds.at(-1) ?? null,
    activeTurnIds: freshActiveTurnIds,
    lastStartedAt,
    lastCompletedAt,
  };
}

export class RolloutWatcher {
  private cache: RolloutCache | null = null;

  private async loadEvents(rolloutPath: string, options: { strict?: boolean } = {}): Promise<ParsedLine[]> {
    const strict = options.strict ?? false;
    const fileStat = await stat(rolloutPath).catch(error => {
      if (strict) {
        throw error;
      }
      return null;
    });
    if (!fileStat) {
      this.cache = null;
      return [];
    }

    const cached = this.cache;
    if (
      cached
      && cached.rolloutPath === rolloutPath
      && cached.size === fileStat.size
      && cached.mtimeMs === fileStat.mtimeMs
    ) {
      return cached.events;
    }

    if (
      cached
      && cached.rolloutPath === rolloutPath
      && fileStat.size > cached.size
      && fileStat.mtimeMs >= cached.mtimeMs
    ) {
      const appended = await readFileSlice(rolloutPath, cached.size, fileStat.size - cached.size).catch(error => {
        if (strict) {
          throw error;
        }
        return "";
      });
      const next = parseChunk(`${cached.tail}${appended}`);
      this.cache = {
        rolloutPath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        events: cached.events.concat(next.events),
        tail: next.tail,
      };
      return this.cache.events;
    }

    if (strict && cached && cached.rolloutPath === rolloutPath && fileStat.size < cached.size) {
      throw new Error(`Rollout file ${rolloutPath} shrank unexpectedly.`);
    }

    const raw = await readFile(rolloutPath, "utf8").catch(error => {
      if (strict) {
        throw error;
      }
      return "";
    });
    const parsed = parseChunk(raw);
    if (strict && parsed.events.length === 0) {
      throw new Error(`Rollout file ${rolloutPath} is empty or unreadable.`);
    }
    this.cache = {
      rolloutPath,
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
      events: parsed.events,
      tail: parsed.tail,
    };
    return parsed.events;
  }

  async inspectTurn(rolloutPath: string, startedAfter: number, options: TurnMatchOptions = {}): Promise<RolloutInspection> {
    return inspectEvents(await this.loadEvents(rolloutPath), startedAfter, options);
  }

  async getThreadActivity(rolloutPath: string): Promise<ThreadActivity> {
    return inspectThreadActivity(await this.loadEvents(rolloutPath, { strict: true }));
  }

  async waitForTurnResult(
    rolloutPath: string,
    startedAfter: number,
    timeoutMs = 180_000,
    options: TurnMatchOptions = {},
  ): Promise<TurnResult> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !options.signal?.aborted) {
      const inspection = await this.inspectTurn(rolloutPath, startedAfter, options);
      if (inspection.result) {
        return inspection.result;
      }
      await sleep(options.pollMs ?? 500, undefined, options.signal ? { signal: options.signal } : undefined)
        .catch(error => {
          if (options.signal?.aborted) {
            return;
          }
          throw error;
        });
    }
    if (options.signal?.aborted) {
      throw new Error(`Aborted waiting for Codex output in ${rolloutPath}`);
    }
    throw new Error(`Timed out waiting for Codex output in ${rolloutPath}`);
  }
}
