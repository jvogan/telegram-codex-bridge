import { EventEmitter } from "node:events";

import { describe, expect, test } from "vitest";

import { createRequestAbortController } from "../src/core/realtime/request-abort.js";

function createPair() {
  const req = new EventEmitter() as EventEmitter & {
    on: typeof EventEmitter.prototype.on;
    off: typeof EventEmitter.prototype.off;
  };
  const res = new EventEmitter() as EventEmitter & {
    writableEnded: boolean;
    on: typeof EventEmitter.prototype.on;
    off: typeof EventEmitter.prototype.off;
  };
  res.writableEnded = false;
  return {
    req: req as never,
    res: res as never,
  };
}

describe("createRequestAbortController", () => {
  test("does not abort when the request stream closes normally", () => {
    const { req, res } = createPair();
    const requestAbort = createRequestAbortController(req, res);

    (req as EventEmitter).emit("close");

    expect(requestAbort.signal.aborted).toBe(false);
  });

  test("aborts when the client aborts the request", () => {
    const { req, res } = createPair();
    const requestAbort = createRequestAbortController(req, res);

    (req as EventEmitter).emit("aborted");

    expect(requestAbort.signal.aborted).toBe(true);
    expect(requestAbort.signal.reason).toBeInstanceOf(Error);
    expect((requestAbort.signal.reason as Error).name).toBe("AbortError");
  });

  test("aborts when the response closes before completion", () => {
    const { req, res } = createPair();
    const requestAbort = createRequestAbortController(req, res);

    (res as EventEmitter).emit("close");

    expect(requestAbort.signal.aborted).toBe(true);
  });
});
