import { describe, expect, test } from "vitest";

import {
  hasTimedAttemptCapacity,
  releaseTimedAttempt,
  recordTimedAttempt,
  reserveTimedAttempt,
  refundTimedAttempt,
  registerTimedAttempt,
  resolveGatewayClientIp,
} from "../src/core/realtime/gateway-security.js";

describe("resolveGatewayClientIp", () => {
  test("ignores spoofable forwarded headers on direct public traffic", () => {
    expect(resolveGatewayClientIp("203.0.113.8", {
      "x-forwarded-for": "198.51.100.9",
      "cf-ray": "abc",
      "cf-connecting-ip": "198.51.100.10",
    })).toBe("203.0.113.8");
  });

  test("ignores spoofable forwarded headers on loopback too", () => {
    expect(resolveGatewayClientIp("127.0.0.1", {
      "cf-ray": "abc",
      "cf-connecting-ip": "198.51.100.10",
      "x-forwarded-for": "198.51.100.11",
    })).toBe("127.0.0.1");
  });

  test("returns loopback unchanged when no forwarded headers are present", () => {
    expect(resolveGatewayClientIp("127.0.0.1", {})).toBe("127.0.0.1");
  });
});

describe("registerTimedAttempt", () => {
  test("tracks attempts within a rolling window", () => {
    const attempts = new Map<string, number[]>();

    expect(registerTimedAttempt(attempts, "call:1", 3, 30_000, 1_000)).toEqual({
      count: 1,
      limitReached: false,
    });
    expect(registerTimedAttempt(attempts, "call:1", 3, 30_000, 2_000)).toEqual({
      count: 2,
      limitReached: false,
    });
    expect(registerTimedAttempt(attempts, "call:1", 3, 30_000, 3_000)).toEqual({
      count: 3,
      limitReached: true,
    });
    expect(registerTimedAttempt(attempts, "call:1", 3, 30_000, 40_001)).toEqual({
      count: 1,
      limitReached: false,
    });
  });
});

describe("timed attempt capacity tracking", () => {
  test("refunding a failed bootstrap frees capacity again", () => {
    const attempts = new Map<string, number[]>();

    expect(hasTimedAttemptCapacity(attempts, "bootstrap:1", 3, 30_000, 1_000)).toBe(true);
    recordTimedAttempt(attempts, "bootstrap:1", 1_000);
    expect(hasTimedAttemptCapacity(attempts, "bootstrap:1", 3, 30_000, 1_000)).toBe(true);

    recordTimedAttempt(attempts, "bootstrap:1", 2_000);
    recordTimedAttempt(attempts, "bootstrap:1", 3_000);
    expect(hasTimedAttemptCapacity(attempts, "bootstrap:1", 3, 30_000, 3_000)).toBe(false);

    refundTimedAttempt(attempts, "bootstrap:1");
    expect(hasTimedAttemptCapacity(attempts, "bootstrap:1", 3, 30_000, 3_000)).toBe(true);
  });

  test("releasing a specific reservation does not remove a different in-flight attempt", () => {
    const attempts = new Map<string, number[]>();

    const first = reserveTimedAttempt(attempts, "bootstrap:1", 3, 30_000, 1_000);
    const second = reserveTimedAttempt(attempts, "bootstrap:1", 3, 30_000, 1_000);
    const third = reserveTimedAttempt(attempts, "bootstrap:1", 3, 30_000, 1_000);

    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(third).not.toBeNull();
    expect(hasTimedAttemptCapacity(attempts, "bootstrap:1", 3, 30_000, 1_000)).toBe(false);

    releaseTimedAttempt(attempts, first);

    expect(hasTimedAttemptCapacity(attempts, "bootstrap:1", 3, 30_000, 1_000)).toBe(true);
    expect(attempts.get("bootstrap:1")).toEqual([
      second!.token,
      third!.token,
    ]);
  });
});
