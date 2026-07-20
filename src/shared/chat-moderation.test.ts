import { describe, expect, it } from "vitest";
import { formatTimeoutDuration } from "./chat";

describe("formatTimeoutDuration", () => {
  it("shows raw seconds under a minute", () => {
    expect(formatTimeoutDuration(1)).toBe("1s");
    expect(formatTimeoutDuration(45)).toBe("45s");
  });

  it("breaks non-round durations into two units instead of raw seconds", () => {
    expect(formatTimeoutDuration(90)).toBe("1m 30s");
    expect(formatTimeoutDuration(3_661)).toBe("1h 1m");
    expect(formatTimeoutDuration(180_000)).toBe("2d 2h");
  });

  it("collapses to a single unit when the remainder is zero", () => {
    expect(formatTimeoutDuration(300)).toBe("5m");
    expect(formatTimeoutDuration(3_600)).toBe("1h");
    expect(formatTimeoutDuration(86_400)).toBe("1d");
  });

  it("clamps invalid input", () => {
    expect(formatTimeoutDuration(-5)).toBe("0s");
    expect(formatTimeoutDuration(0)).toBe("0s");
  });
});
