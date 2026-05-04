import { redactLogFields } from "./redaction.js";

export interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

function emit(level: string, message: string, fields?: Record<string, unknown>): void {
  const redactedFields = redactLogFields(fields);
  const payload = {
    ts: new Date().toISOString(),
    level,
    message,
    ...(redactedFields && Object.keys(redactedFields).length > 0 ? { fields: redactedFields } : {}),
  };
  const line = JSON.stringify(payload);
  if (level === "error") {
    console.error(line);
    return;
  }
  console.log(line);
}

export function createLogger(scope: string): Logger {
  return {
    info(message, fields) {
      emit("info", `[${scope}] ${message}`, fields);
    },
    warn(message, fields) {
      emit("warn", `[${scope}] ${message}`, fields);
    },
    error(message, fields) {
      emit("error", `[${scope}] ${message}`, fields);
    },
  };
}
