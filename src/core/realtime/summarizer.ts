import OpenAI from "openai";
import { z } from "zod";

import type { BridgeConfig, BridgeEnv } from "../config.js";
import type { CallArtifact, CallContextPack, CallInboxItem } from "../types.js";

const summarySchema = z.object({
  summary: z.string().min(1),
  decisions: z.array(z.string()).default([]),
  action_items: z.array(z.string()).default([]),
  open_questions: z.array(z.string()).default([]),
  important_facts: z.array(z.string()).default([]),
});

export class CallSummarizer {
  private readonly client: OpenAI | null;

  constructor(
    private readonly config: BridgeConfig,
    env: BridgeEnv,
  ) {
    this.client = env.openaiApiKey ? new OpenAI({ apiKey: env.openaiApiKey }) : null;
  }

  private fallbackSummary(transcript: string, inboxItems: CallInboxItem[]): z.infer<typeof summarySchema> {
    const latestLine = transcript
      .split("\n")
      .map(line => line.trim())
      .filter(line => Boolean(line) && !line.startsWith("# Call"))
      .at(-1);
    return {
      summary: latestLine ? `Call completed. Latest transcript line: ${latestLine}` : "Call ended without a usable transcript.",
      decisions: [],
      action_items: inboxItems.map(item => `Review in-call ${item.kind}: ${item.text}`),
      open_questions: [],
      important_facts: [],
    };
  }

  async summarize(input: {
    contextPack: CallContextPack | null;
    transcript: string;
    inboxItems: CallInboxItem[];
  }): Promise<z.infer<typeof summarySchema>> {
    const meaningfulTranscript = input.transcript
      .split("\n")
      .map(line => line.trim())
      .filter(line => Boolean(line) && !line.startsWith("# Call"))
      .join("\n");
    if (!meaningfulTranscript && input.inboxItems.length === 0) {
      return this.fallbackSummary(input.transcript, input.inboxItems);
    }
    if (!this.client) {
      return this.fallbackSummary(input.transcript, input.inboxItems);
    }
    const prompt = [
      "Summarize this live call for a coding assistant handoff.",
      "Return strict JSON only with keys: summary, decisions, action_items, open_questions, important_facts.",
      "Keep items concise.",
      "",
      "Context pack:",
      JSON.stringify(input.contextPack ?? null, null, 2),
      "",
      "In-call inbox:",
      JSON.stringify(input.inboxItems.map(item => ({
        id: item.id,
        kind: item.kind,
        text: item.text,
        transcriptText: item.transcriptText ?? null,
      })), null, 2),
      "",
      "Transcript:",
      meaningfulTranscript || "(empty)",
    ].join("\n");
    try {
      const response = await this.client.responses.create({
        model: this.config.realtime.summary_model,
        input: prompt,
      } as never);
      const text = typeof (response as any).output_text === "string"
        ? (response as any).output_text
        : "";
      const parsed = JSON.parse(text);
      return summarySchema.parse(parsed);
    } catch {
      return this.fallbackSummary(input.transcript, input.inboxItems);
    }
  }
}

export function buildCallArtifact(input: {
  callId: string;
  boundThreadId: string | null;
  cwd: string | null;
  startedAt: number;
  endedAt: number;
  endedReason: string;
  transcriptPath: string;
  attachments: CallArtifact["attachments"];
  summary: z.infer<typeof summarySchema>;
}): CallArtifact {
  return {
    callId: input.callId,
    boundThreadId: input.boundThreadId,
    cwd: input.cwd,
    startedAt: input.startedAt,
    endedAt: input.endedAt,
    endedReason: input.endedReason,
    summary: input.summary.summary,
    decisions: input.summary.decisions,
    actionItems: input.summary.action_items,
    openQuestions: input.summary.open_questions,
    importantFacts: input.summary.important_facts,
    attachments: input.attachments,
    transcriptPath: input.transcriptPath,
  };
}
