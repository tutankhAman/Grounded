import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module("ai", () => ({
  embedMany: mock(async () => ({ embeddings: [] })),
  generateObject: mock(async () => ({
    object: { facts: [] },
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
  })),
  generateText: mock(async () => ({ text: '{"facts": []}' })),
}));

// Import after the mock so llm.ts binds the stubbed SDK. No network is
// touched: generateObject is stubbed and the provider client only builds
// request config. Tests set a dummy LLM_API_KEY for provider construction.
const { envOr, extractBatch, normalizeUsage, resolveJudgeModelName } =
  await import("./llm");

import type { TokenUsage } from "./llm";

const ORIGINAL_KEY = process.env.LLM_API_KEY;

afterEach(() => {
  if (ORIGINAL_KEY === undefined) {
    delete process.env.LLM_API_KEY;
  } else {
    process.env.LLM_API_KEY = ORIGINAL_KEY;
  }
});

describe("llm usage reporting (mocked SDK, no network)", () => {
  test("extractBatch reports normalized usage via onUsage", async () => {
    process.env.LLM_API_KEY = "test-key";
    const seen: TokenUsage[] = [];
    const facts = await extractBatch(
      [{ pageNumber: 1, text: "Acme revenue was 100M." }],
      {
        onUsage: (u) => {
          seen.push(u);
        },
      }
    );

    expect(facts).toEqual([]);
    expect(seen.length).toBe(1);
    expect(seen[0]).toEqual({
      inputTokens: 10,
      outputTokens: 20,
      totalTokens: 30,
    });
  });

  test("extractBatch works without onUsage (callback optional)", async () => {
    process.env.LLM_API_KEY = "test-key";
    const facts = await extractBatch([
      { pageNumber: 1, text: "Acme revenue was 100M." },
    ]);
    expect(facts).toEqual([]);
  });

  test("normalizeUsage fills missing fields with zero instead of NaN", () => {
    expect(normalizeUsage({ inputTokens: undefined, outputTokens: 5 })).toEqual(
      { inputTokens: 0, outputTokens: 5, totalTokens: 5 }
    );
    expect(normalizeUsage({})).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(
      normalizeUsage({ inputTokens: 7, outputTokens: 8, totalTokens: 15 })
    ).toEqual({ inputTokens: 7, outputTokens: 8, totalTokens: 15 });
  });
});

describe("model selection (empty-string-safe env fallback)", () => {
  const KEYS = ["JUDGE_MODEL", "TEXT_MODEL"] as const;
  const saved: Record<string, string | undefined> = {};

  const setEnv = (values: Partial<Record<string, string | undefined>>) => {
    for (const k of KEYS) {
      if (!(k in saved)) {
        saved[k] = process.env[k];
      }
      const v = values[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  };

  const restoreEnv = () => {
    for (const k of KEYS) {
      const v = saved[k];
      if (v === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = v;
      }
    }
  };

  test("envOr treats empty and whitespace-only strings as missing", () => {
    expect(envOr("model-x", "fallback")).toBe("model-x");
    expect(envOr("", "fallback")).toBe("fallback");
    expect(envOr("   ", "fallback")).toBe("fallback");
    expect(envOr(undefined, "fallback")).toBe("fallback");
    restoreEnv();
  });

  test("JUDGE_MODEL='' falls back to TEXT_MODEL (regression: empty model id)", () => {
    setEnv({ JUDGE_MODEL: "", TEXT_MODEL: "gemini-3.5-flash-lite" });
    try {
      expect(resolveJudgeModelName()).toBe("gemini-3.5-flash-lite");
    } finally {
      restoreEnv();
    }
  });

  test("explicit JUDGE_MODEL wins; unset chain reaches the default", () => {
    setEnv({ JUDGE_MODEL: "judge-v1", TEXT_MODEL: "text-v1" });
    try {
      expect(resolveJudgeModelName()).toBe("judge-v1");
      expect(resolveJudgeModelName("override-v9")).toBe("override-v9");
    } finally {
      restoreEnv();
    }
    setEnv({ JUDGE_MODEL: undefined, TEXT_MODEL: undefined });
    try {
      expect(resolveJudgeModelName()).toBe("gemini-3.5-flash-lite");
    } finally {
      restoreEnv();
    }
  });
});
