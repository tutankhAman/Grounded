import { describe, expect, test } from "bun:test";
import { endStage, stageElapsedMs, startStage } from "./stage-timing";

describe("stage-timing stopwatch", () => {
  test("unknown document has no elapsed time", () => {
    expect(stageElapsedMs("missing-doc")).toBeUndefined();
  });

  test("elapsed grows monotonically from an explicit start", () => {
    startStage("doc-a", 1000);
    expect(stageElapsedMs("doc-a", 1000)).toBe(0);
    expect(stageElapsedMs("doc-a", 2500)).toBe(1500);
  });

  test("elapsed never goes negative on clock skew", () => {
    startStage("doc-b", 5000);
    expect(stageElapsedMs("doc-b", 4999)).toBe(0);
  });

  test("tracks documents independently", () => {
    startStage("doc-c", 0);
    startStage("doc-d", 10_000);
    expect(stageElapsedMs("doc-c", 20_000)).toBe(20_000);
    expect(stageElapsedMs("doc-d", 20_000)).toBe(10_000);
  });

  test("endStage clears the entry; restart overwrites stale state", () => {
    startStage("doc-e", 0);
    endStage("doc-e");
    expect(stageElapsedMs("doc-e", 9999)).toBeUndefined();
    endStage("doc-missing");
    startStage("doc-e", 7000);
    expect(stageElapsedMs("doc-e", 8000)).toBe(1000);
  });
});
