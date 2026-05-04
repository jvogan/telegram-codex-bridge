import { spawn } from "node:child_process";
import { basename, extname } from "node:path";

import { ensureParent } from "./files.js";

const FFMPEG_TIMEOUT_MS = 60_000;

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg timed out after ${FFMPEG_TIMEOUT_MS}ms: ${stderr.trim()}`.trim()));
    }, FFMPEG_TIMEOUT_MS);
    timer.unref?.();
    child.stderr.on("data", chunk => {
      stderr += chunk.toString();
    });
    child.on("error", error => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", code => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
    });
  });
}

export async function transcodeToWav(inputPath: string, outputPath: string): Promise<string> {
  ensureParent(outputPath);
  await runFfmpeg(["-y", "-i", inputPath, "-ac", "1", "-ar", "16000", outputPath]);
  return outputPath;
}

export async function extractVideoFrame(inputPath: string, outputPath: string, seekSeconds = 1): Promise<string> {
  ensureParent(outputPath);
  await runFfmpeg([
    "-y",
    "-ss",
    String(Math.max(0, seekSeconds)),
    "-i",
    inputPath,
    "-frames:v",
    "1",
    "-vf",
    "scale=1280:-1",
    outputPath,
  ]);
  return outputPath;
}

export async function transcodeToTelegramVoice(inputPath: string, outputPath: string): Promise<string> {
  ensureParent(outputPath);
  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-c:a",
    "libopus",
    "-b:a",
    "48k",
    "-vbr",
    "on",
    outputPath,
  ]);
  return outputPath;
}

export function replaceExtension(fileName: string, nextExtension: string): string {
  const base = basename(fileName, extname(fileName));
  return `${base}.${nextExtension}`;
}
