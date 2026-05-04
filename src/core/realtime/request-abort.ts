import type { IncomingMessage, ServerResponse } from "node:http";

function abortError(message: string): Error {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function createRequestAbortController(
  req: IncomingMessage,
  res: ServerResponse,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const abort = (): void => {
    if (controller.signal.aborted || res.writableEnded) {
      return;
    }
    controller.abort(abortError("Client disconnected during live-call bootstrap."));
  };
  const cleanup = (): void => {
    req.off("aborted", abort);
    res.off("close", abort);
    res.off("finish", cleanup);
  };

  // `IncomingMessage#close` also fires after a normal request body finishes,
  // so only treat explicit aborts and response-side closes as disconnects.
  req.on("aborted", abort);
  res.on("close", abort);
  res.on("finish", cleanup);

  return {
    signal: controller.signal,
    cleanup,
  };
}
