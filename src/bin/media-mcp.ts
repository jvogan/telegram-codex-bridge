import "dotenv/config";

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ArtifactStore } from "../core/artifacts.js";
import { loadBridgeEnv, loadConfig } from "../core/config.js";
import { createLogger } from "../core/logger.js";
import { MediaRegistry } from "../core/media/registry.js";
import { BridgeState } from "../core/state.js";
import { PROVIDERS_BY_MODALITY } from "../core/types.js";
import type { Modality, ProviderId } from "../core/types.js";
import { resolveAllowedAudioPath } from "../core/util/path-policy.js";

const entryDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(entryDir, "../..");
process.env.BRIDGE_CONFIG_PATH ??= join(repoRoot, "bridge.config.toml");

const logger = createLogger("media-mcp");
const config = loadConfig();
const env = loadBridgeEnv(config);
const state = new BridgeState(config.storageRoot);
const registry = new MediaRegistry(config, env, state);
const artifacts = new ArtifactStore(config.storageRoot, state);

const asrProviderSchema = z.enum(PROVIDERS_BY_MODALITY.asr);
const ttsProviderSchema = z.enum(PROVIDERS_BY_MODALITY.tts);
const imageProviderSchema = z.enum(PROVIDERS_BY_MODALITY.image_generation);

function textResult(text: string, structuredContent?: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text }],
    ...(structuredContent ? { structuredContent } : {}),
  };
}

function formatStatuses(statuses: Awaited<ReturnType<MediaRegistry["getProviderStatuses"]>>, registryInstance: MediaRegistry): string {
  const lines = [
    "Configured provider chains",
    `ASR: ${registryInstance.getEffectiveChain("asr").join(" -> ")}`,
    `TTS: ${registryInstance.getEffectiveChain("tts").join(" -> ")}`,
    `Image: ${registryInstance.getEffectiveChain("image_generation").join(" -> ")}`,
    "",
  ];
  for (const modality of ["asr", "tts", "image_generation"] as const satisfies Modality[]) {
    lines.push(`${modality}:`);
    for (const entry of statuses[modality]) {
      lines.push(`- ${entry.id}: ${entry.available ? "available" : "unavailable"} (${entry.detail})`);
    }
  }
  return lines.join("\n");
}

const server = new McpServer({
  name: "telegram-codex-bridge-media",
  version: "0.1.0",
});

server.registerTool("media_list_providers", {
  title: "List Media Providers",
  description: "List ASR, TTS, and image-generation providers, their fallback chains, and current health.",
}, async () => {
  const statuses = await registry.getProviderStatuses();
  return textResult(
    formatStatuses(statuses, registry),
    {
      effectiveChains: {
        asr: registry.getEffectiveChain("asr"),
        tts: registry.getEffectiveChain("tts"),
        image_generation: registry.getEffectiveChain("image_generation"),
      },
      statuses,
    },
  );
});

server.registerTool("media_transcribe", {
  title: "Transcribe Audio",
  description: "Transcribe a local audio file using the configured ASR chain or an explicitly chosen provider.",
  inputSchema: {
    filePath: z.string().min(1).describe("Absolute or repo-relative path to the audio file."),
    provider: asrProviderSchema.optional().describe("Optional ASR provider override."),
    model: z.string().optional().describe("Optional model override."),
    prompt: z.string().optional().describe("Optional transcription prompt."),
    language: z.string().optional().describe("Optional BCP-47 or ISO language hint."),
  },
}, async ({ filePath, provider, model, prompt, language }) => {
  const boundThread = state.getBoundThread();
  const absolutePath = await resolveAllowedAudioPath(filePath, [
    ...(config.codex.workdir ? [config.codex.workdir] : []),
    ...(boundThread?.cwd ? [boundThread.cwd] : []),
    config.storageRoot,
  ]);
  const result = await registry.transcribe({
    filePath: absolutePath,
    ...(provider ? { providerId: provider } : {}),
    ...(model ? { model } : {}),
    ...(prompt ? { prompt } : {}),
    ...(language ? { language } : {}),
  });
  const artifact = await artifacts.writeArtifact({
    modality: "transcript",
    providerId: result.providerId,
    source: "mcp",
    buffer: Buffer.from(result.text, "utf8"),
    fileExtension: "txt",
    mimeType: "text/plain",
    metadata: { filePath: absolutePath },
  });
  return textResult(result.text, {
    providerId: result.providerId,
    artifactPath: artifact.path,
    text: result.text,
  });
});

server.registerTool("media_speak", {
  title: "Synthesize Speech",
  description: "Generate speech audio from text using the configured TTS chain or an explicitly chosen provider.",
  inputSchema: {
    text: z.string().min(1).describe("Text to synthesize."),
    provider: ttsProviderSchema.optional().describe("Optional TTS provider override."),
    model: z.string().optional().describe("Optional model override."),
    voice: z.string().optional().describe("Optional voice override."),
    instructions: z.string().optional().describe("Optional style or delivery instructions."),
    responseFormat: z.string().optional().describe("Optional format hint like wav or mp3."),
  },
}, async ({ text, provider, model, voice, instructions, responseFormat }) => {
  const result = await registry.speak({
    text,
    ...(provider ? { providerId: provider } : {}),
    ...(model ? { model } : {}),
    ...(voice ? { voice } : {}),
    ...(instructions ? { instructions } : {}),
    ...(responseFormat ? { responseFormat } : {}),
  });
  const artifact = await artifacts.writeArtifact({
    modality: "audio",
    providerId: result.providerId,
    source: "mcp",
    buffer: result.buffer,
    fileExtension: result.fileExtension,
    mimeType: result.mimeType,
    metadata: { textPreview: text.slice(0, 160) },
  });
  return textResult(`Speech generated at ${artifact.path}`, {
    providerId: result.providerId,
    artifactPath: artifact.path,
    mimeType: artifact.mimeType,
    fileName: artifact.fileName,
  });
});

server.registerTool("media_generate_image", {
  title: "Generate Image",
  description: "Generate an image via the configured image provider chain or an explicitly chosen provider.",
  inputSchema: {
    prompt: z.string().min(1).describe("Image generation prompt."),
    provider: imageProviderSchema.optional().describe("Optional image provider override."),
    model: z.string().optional().describe("Optional model override."),
    size: z.string().optional().describe("Optional size override, for providers that support it."),
    aspectRatio: z.string().optional().describe("Optional aspect ratio override, for providers that support it."),
  },
}, async ({ prompt, provider, model, size, aspectRatio }) => {
  const result = await registry.generateImage({
    prompt,
    ...(provider ? { providerId: provider } : {}),
    ...(model ? { model } : {}),
    ...(size ? { size } : {}),
    ...(aspectRatio ? { aspectRatio } : {}),
  });
  const artifact = await artifacts.writeArtifact({
    modality: "image",
    providerId: result.providerId,
    source: "mcp",
    buffer: result.buffer,
    fileExtension: result.fileExtension,
    mimeType: result.mimeType,
    metadata: {
      prompt,
      ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
    },
  });
  return textResult(`Image generated at ${artifact.path}`, {
    providerId: result.providerId,
    artifactPath: artifact.path,
    mimeType: artifact.mimeType,
    fileName: artifact.fileName,
    ...(result.revisedPrompt ? { revisedPrompt: result.revisedPrompt } : {}),
  });
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info("media MCP server ready");
}

main().catch(error => {
  logger.error("media MCP startup failure", {
    error: error instanceof Error ? error.message : String(error),
  });
  process.exitCode = 1;
});
