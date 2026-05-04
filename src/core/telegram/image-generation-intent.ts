export interface ImageGenerationContextItem {
  title: string;
}

function compactPromptText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function imageGenerationRequestText(task: {
  text?: string;
  transcriptText?: string;
}): string {
  return compactPromptText(
    [task.text, task.transcriptText]
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .join("\n"),
  );
}

export function buildDirectImageGenerationPrompt(
  requestText: string,
  context?: ImageGenerationContextItem | null,
): string {
  const request = compactPromptText(requestText);
  const noTextGuidance = "Do not include text labels, captions, logos, watermarks, UI, or file paths unless the user explicitly requested text inside the image.";

  if (context?.title) {
    return [
      `User request: ${request}`,
      `Active context: ${context.title}`,
      "Create a polished visual that reflects the user's requested context. Keep the composition clear, self-contained, and uncluttered.",
      noTextGuidance,
    ].join("\n");
  }

  return [
    `User request: ${request}`,
    "Make the image polished, self-contained, and visually clear.",
    noTextGuidance,
  ].join("\n");
}
