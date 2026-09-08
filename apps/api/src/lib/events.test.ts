import { describe, expect, it } from "bun:test";
import { isProgressEvent, isTerminalStatus } from "./events";

describe("events pure utilities", () => {
  describe("isTerminalStatus", () => {
    it("returns true for terminal statuses ('done', 'failed')", () => {
      expect(isTerminalStatus("done")).toBe(true);
      expect(isTerminalStatus("failed")).toBe(true);
    });

    it("returns false for non-terminal statuses", () => {
      expect(isTerminalStatus("pending")).toBe(false);
      expect(isTerminalStatus("parsing")).toBe(false);
      expect(isTerminalStatus("parsed")).toBe(false);
      expect(isTerminalStatus("extracting")).toBe(false);
      expect(isTerminalStatus("extracted")).toBe(false);
      expect(isTerminalStatus("resolving")).toBe(false);
      expect(isTerminalStatus("resolved")).toBe(false);
      expect(isTerminalStatus("reconciling")).toBe(false);
    });

    it("returns false for non-strings and unknown values", () => {
      expect(isTerminalStatus(null)).toBe(false);
      expect(isTerminalStatus(undefined)).toBe(false);
      expect(isTerminalStatus(123)).toBe(false);
      expect(isTerminalStatus("unknown_status")).toBe(false);
    });
  });

  describe("isProgressEvent", () => {
    it("validates valid progress events", () => {
      expect(
        isProgressEvent({
          progress: { current: 3, total: 10 },
          stage: "extract",
          status: "extracting",
        })
      ).toBe(true);

      expect(
        isProgressEvent({
          errorMessage: null,
          progress: { current: 10, total: 10 },
          status: "done",
        })
      ).toBe(true);

      expect(
        isProgressEvent({
          errorMessage: "Failed to extract text",
          progress: { current: 0, total: 1 },
          stage: "parse",
          status: "failed",
        })
      ).toBe(true);
    });

    it("rejects non-object or null values", () => {
      expect(isProgressEvent(null)).toBe(false);
      expect(isProgressEvent(undefined)).toBe(false);
      expect(isProgressEvent("string")).toBe(false);
      expect(isProgressEvent(42)).toBe(false);
      expect(isProgressEvent([])).toBe(false);
    });

    it("rejects invalid status", () => {
      expect(
        isProgressEvent({
          progress: { current: 1, total: 1 },
          status: "not_a_status",
        })
      ).toBe(false);
    });

    it("rejects invalid progress structures", () => {
      expect(isProgressEvent({ status: "parsing" })).toBe(false);
      expect(
        isProgressEvent({
          progress: { current: "1", total: 2 },
          status: "parsing",
        })
      ).toBe(false);
      expect(
        isProgressEvent({
          progress: { current: Number.NaN, total: 2 },
          status: "parsing",
        })
      ).toBe(false);
      expect(
        isProgressEvent({
          progress: { current: 1, total: Number.POSITIVE_INFINITY },
          status: "parsing",
        })
      ).toBe(false);
    });

    it("rejects invalid stage values", () => {
      expect(
        isProgressEvent({
          progress: { current: 1, total: 1 },
          stage: "invalid_stage",
          status: "parsing",
        })
      ).toBe(false);
    });

    it("rejects invalid errorMessage types", () => {
      expect(
        isProgressEvent({
          errorMessage: 12_345,
          progress: { current: 1, total: 1 },
          status: "failed",
        })
      ).toBe(false);
    });

    it("accepts a valid elapsedMs and rejects malformed values", () => {
      expect(
        isProgressEvent({
          elapsedMs: 12_345,
          progress: { current: 3, total: 10 },
          stage: "extract",
          status: "extracting",
        })
      ).toBe(true);

      expect(
        isProgressEvent({
          elapsedMs: 0,
          progress: { current: 0, total: 10 },
          status: "parsing",
        })
      ).toBe(true);

      expect(
        isProgressEvent({
          elapsedMs: -5,
          progress: { current: 1, total: 1 },
          status: "parsing",
        })
      ).toBe(false);
      expect(
        isProgressEvent({
          elapsedMs: Number.NaN,
          progress: { current: 1, total: 1 },
          status: "parsing",
        })
      ).toBe(false);
      expect(
        isProgressEvent({
          elapsedMs: "soon",
          progress: { current: 1, total: 1 },
          status: "parsing",
        })
      ).toBe(false);
    });
  });
});
