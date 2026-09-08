import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  db,
  documents,
  eq,
  facts,
  factTypes,
  pageChunks,
  sql,
} from "@grounded/db";
import dotenv from "dotenv";
import Redis from "ioredis";
import {
  applyQuoteValidation,
  duplicateTripleRate,
  summarizeQuoteLengths,
  validateQuote,
} from "../pipeline/extractor";
import {
  ExtractionFailedError,
  embedSingle,
  extractTextChunk,
  extractVisionPage,
} from "../pipeline/llm";
import { imagePathToDataUrl, renderPageImage } from "../pipeline/renderer";
import { canonicalizeFactType, processExtractJob } from "./extract";
import { processParseJob, pubRedis } from "./parse";

dotenv.config({ path: resolve(import.meta.dirname, "../../../../.env") });

// Fail-fast preflight per specification
const hasKey = Boolean(process.env.LLM_API_KEY || process.env.GEMINI_API_KEY);
if (!hasKey) {
  throw new Error("Live test requires LLM_API_KEY or GEMINI_API_KEY");
}
if (!process.env.DATABASE_URL) {
  throw new Error("Live test requires DATABASE_URL");
}
if (!process.env.REDIS_URL) {
  throw new Error("Live test requires REDIS_URL");
}

// Cost caps baked into test file
const COST_CAPS = {
  maxGeminiEmbeddingCalls: 10,
  maxGeminiVisionCalls: 3,
  maxTextCalls: 5,
};

let textCallCount = 0;
let geminiVisionCallCount = 0;
let geminiEmbeddingCallCount = 0;

const benchmarkMetrics: Array<{
  action: string;
  itemsExtracted: number;
  tokensEstimated: number;
  wallClockMs: number;
}> = [];

describe("Phase-2 Live Fact Extraction Integration Suite", () => {
  const fixturePdfPath = resolve(
    import.meta.dirname,
    "fixtures/fixture-report.pdf"
  );

  beforeAll(() => {
    if (!existsSync(fixturePdfPath)) {
      throw new Error(`Fixture PDF not found at ${fixturePdfPath}`);
    }
  });

  afterAll(async () => {
    await pubRedis.quit().catch((_err) => {
      // Ignore disconnect error
    });
  });

  test("Test 1: Real chunk text extract -> >= 1 fact, every quote in rawText", async () => {
    textCallCount++;
    if (textCallCount > COST_CAPS.maxTextCalls) {
      throw new Error(
        `Cost cap exceeded: max ${COST_CAPS.maxTextCalls} text calls allowed.`
      );
    }

    const chunkText =
      "In fiscal year 2023, Acme Corporation reported total revenue of $4.2 billion, representing a 12% increase year-over-year. Operating margin expanded to 28.5%.";

    const usage: { inputTokens: number; outputTokens: number }[] = [];
    const t0 = Date.now();
    const extracted = await extractTextChunk(chunkText, {
      onUsage: (u) => {
        usage.push(u);
      },
    });
    const wallClockMs = Date.now() - t0;

    expect(extracted.length).toBeGreaterThanOrEqual(1);

    for (const fact of extracted) {
      expect(typeof fact.predicate).toBe("string");
      expect(typeof fact.value).toBe("string");
      expect(typeof fact.sourceQuote).toBe("string");
      expect(fact.sourceQuote.length).toBeGreaterThan(0);
      expect(validateQuote(fact, chunkText)).toBe(true);
      expect(fact.confidence).toBeGreaterThan(0);
    }

    const dupScore = duplicateTripleRate(extracted);
    console.log(
      `[Selectivity] Test 1: ${extracted.length} facts, real usage in=${usage[0]?.inputTokens ?? "?"} out=${usage[0]?.outputTokens ?? "?"}, dup-triple rate=${(dupScore.rate * 100).toFixed(1)}%, quote lengths=${JSON.stringify(summarizeQuoteLengths(extracted.map((f) => f.sourceQuote)))}`
    );

    benchmarkMetrics.push({
      action: "Test 1: Gemini text extraction",
      itemsExtracted: extracted.length,
      tokensEstimated:
        usage[0]?.outputTokens ?? Math.ceil(chunkText.length / 4),
      wallClockMs,
    });
  }, 90_000);

  test("Test 2: Forced failure (invalid prompt) -> extraction_failed chunk row, job continues", async () => {
    // A. Verify extractTextChunk throws ExtractionFailedError on forced/refusal prompt
    await expect(
      extractTextChunk("Some narrative text", { forceFailure: true })
    ).rejects.toThrow(ExtractionFailedError);

    // B. Verify in-job resilience: chunk failure sets extraction_failed, and job continues
    const [testDoc] = await db
      .insert(documents)
      .values({
        filename: "test-resilience.pdf",
        filePath: "/tmp/fake-test-doc.pdf",
        status: "uploaded",
      })
      .returning();

    const [chunkGood] = await db
      .insert(pageChunks)
      .values({
        chunkIndex: 0,
        documentId: testDoc.id,
        extractionStatus: "pending",
        isLowText: false,
        isTableHeavy: false,
        needsVision: false,
        pageNumber: 1,
        rawText: "Acme Corporation reported annual revenue of $4.2 billion.",
        tokenEstimate: 50,
      })
      .returning();

    const [chunkBad] = await db
      .insert(pageChunks)
      .values({
        chunkIndex: 0,
        documentId: testDoc.id,
        extractionStatus: "pending",
        isLowText: false,
        isTableHeavy: false,
        needsVision: false,
        pageNumber: 2,
        rawText: "Corrupted input designed to trigger extraction failure.",
        tokenEstimate: 50,
      })
      .returning();

    try {
      // Run extract job with an injected extractor where chunkBad throws ExtractionFailedError
      const res = await processExtractJob(
        { documentId: testDoc.id },
        {
          textExtractor: (text) => {
            if (text.includes("Corrupted")) {
              return Promise.reject(
                new ExtractionFailedError("Simulated invalid prompt failure", {
                  rawOutput: "ERROR",
                })
              );
            }
            return Promise.resolve([
              {
                confidence: 1,
                currency: "USD",
                entity: {
                  context: "Acme revenue",
                  name: "Acme Corporation",
                  type: "Company",
                },
                factTypeDescription: "Annual revenue",
                predicate: "revenue",
                qualifiers: null,
                rawValue: "$4.2 billion",
                sourceQuote: "annual revenue of $4.2 billion",
                timeScope: "2023",
                unit: "billion",
                value: "4.2",
              },
            ]);
          },
        }
      );

      // Job continued and finished
      expect(res.chunksFailed).toBe(1);
      expect(res.factsExtracted).toBe(1);

      // Check DB statuses
      const [goodInDb] = await db
        .select()
        .from(pageChunks)
        .where(eq(pageChunks.id, chunkGood.id));
      const [badInDb] = await db
        .select()
        .from(pageChunks)
        .where(eq(pageChunks.id, chunkBad.id));
      const [docInDb] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, testDoc.id));

      expect(goodInDb.extractionStatus).toBe("extracted");
      expect(badInDb.extractionStatus).toBe("extraction_failed");
      expect(docInDb.status).toBe("extracted");
    } finally {
      await db.delete(facts).where(eq(facts.documentId, testDoc.id));
      await db.delete(pageChunks).where(eq(pageChunks.documentId, testDoc.id));
      await db.delete(documents).where(eq(documents.id, testDoc.id));
    }
  }, 20_000);

  test("Test 3: Embed + persist -> vector(1536) roundtrip with cosine self-similarity ≈ 1", async () => {
    geminiEmbeddingCallCount++;
    if (geminiEmbeddingCallCount > COST_CAPS.maxGeminiEmbeddingCalls) {
      throw new Error(
        `Cost cap exceeded: max ${COST_CAPS.maxGeminiEmbeddingCalls} embedding calls allowed.`
      );
    }

    const t0 = Date.now();
    const embedding = await embedSingle(
      "category: corporate annual net revenue"
    );
    const wallClockMs = Date.now() - t0;

    expect(embedding.length).toBe(1536);
    for (const val of embedding) {
      expect(typeof val).toBe("number");
      expect(Number.isFinite(val)).toBe(true);
    }

    const testName = `test_roundtrip_${Date.now()}`;
    const [created] = await db
      .insert(factTypes)
      .values({
        description: "Vector roundtrip test description",
        embedding,
        examplePredicates: ["test_predicate"],
        name: testName,
      })
      .returning({ id: factTypes.id });

    try {
      const vectorStr = `[${embedding.join(",")}]`;
      const [queried] = await db
        .select({
          distance: sql<number>`${factTypes.embedding} <=> ${vectorStr}::vector`,
          id: factTypes.id,
        })
        .from(factTypes)
        .where(eq(factTypes.id, created.id));

      expect(queried).toBeDefined();
      const similarity = 1 - Number(queried.distance);
      // Cosine distance to itself must be ~0, similarity must be ~1.0
      expect(similarity).toBeGreaterThan(0.9999);

      benchmarkMetrics.push({
        action: "Test 3: Gemini MRL-1536 embedding roundtrip",
        itemsExtracted: 1,
        tokensEstimated: 10,
        wallClockMs,
      });
    } finally {
      await db.delete(factTypes).where(eq(factTypes.id, created.id));
    }
  }, 20_000);

  test("Test 4: Paraphrase dedup ('annual revenue' vs 'total yearly income') -> 1 fact_types row", async () => {
    geminiEmbeddingCallCount += 2;
    if (geminiEmbeddingCallCount > COST_CAPS.maxGeminiEmbeddingCalls) {
      throw new Error(
        `Cost cap exceeded: max ${COST_CAPS.maxGeminiEmbeddingCalls} embedding calls allowed.`
      );
    }

    const t0 = Date.now();
    const id1 = await canonicalizeFactType(
      "annual revenue generated by a corporate entity",
      "annual_revenue"
    );
    const id2 = await canonicalizeFactType(
      "total yearly income generated by a corporate entity",
      "yearly_income"
    );
    const wallClockMs = Date.now() - t0;

    expect(id1).toBe(id2);

    const [row] = await db
      .select()
      .from(factTypes)
      .where(eq(factTypes.id, id1));

    expect(row).toBeDefined();
    const examples = row.examplePredicates as string[];
    expect(examples).toContain("annual_revenue");
    expect(examples).toContain("yearly_income");

    benchmarkMetrics.push({
      action: "Test 4: Fact types canonicalization dedup",
      itemsExtracted: 1,
      tokensEstimated: 25,
      wallClockMs,
    });

    await db.delete(factTypes).where(eq(factTypes.id, id1));
  }, 20_000);

  test("Test 5: Full processExtractJob on fixture-report.pdf -> extracted, progress observed on Redis, re-run => 0 duplicates", async () => {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
    const subRedis = new Redis(redisUrl, { lazyConnect: true });
    await subRedis.connect();

    const progressEvents: Array<{
      progress?: { current: number; total: number };
      status: string;
    }> = [];

    const [doc] = await db
      .insert(documents)
      .values({
        filename: "fixture-report.pdf",
        filePath: fixturePdfPath,
        status: "uploaded",
      })
      .returning();

    try {
      await subRedis.subscribe(`doc:${doc.id}:status`);
      subRedis.on("message", (_channel, message) => {
        try {
          progressEvents.push(JSON.parse(message));
        } catch {
          // Ignore non-JSON broadcast messages
        }
      });

      // 1. Run parse job
      const parseRes = await processParseJob({
        documentId: doc.id,
        filePath: fixturePdfPath,
      });
      expect(parseRes.totalChunks).toBe(2);
      expect(parseRes.totalPages).toBe(2);

      // 2. Run extract job
      const t0 = Date.now();
      const extractRes = await processExtractJob({
        documentId: doc.id,
      });
      const wallClockMs = Date.now() - t0;

      expect(extractRes.documentId).toBe(doc.id);
      expect(extractRes.factsExtracted).toBeGreaterThanOrEqual(1);

      // Verify document status in DB
      const [docInDb] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, doc.id));
      expect(docInDb.status).toBe("extracted");

      // Verify Redis progress messages
      const statuses = progressEvents.map((e) => e.status);
      expect(statuses).toContain("extracting");
      expect(statuses).toContain("extracted");

      // Count facts extracted
      const factsRun1 = await db
        .select()
        .from(facts)
        .where(eq(facts.documentId, doc.id));
      expect(factsRun1.length).toBe(extractRes.factsExtracted);

      // Selectivity scoreboard on the full fixture document
      const dupScore = duplicateTripleRate(factsRun1);
      console.log(
        `[Selectivity] Test 5: ${factsRun1.length} facts persisted, dup-triple rate=${(dupScore.rate * 100).toFixed(1)}%, quote lengths=${JSON.stringify(summarizeQuoteLengths(factsRun1.map((f) => f.sourceQuote)))}, wallClockMs=${wallClockMs}`
      );

      // 3. Re-run processExtractJob (Idempotency test)
      const rerunRes = await processExtractJob({
        documentId: doc.id,
      });

      const factsRun2 = await db
        .select()
        .from(facts)
        .where(eq(facts.documentId, doc.id));

      // Re-run must replace previous facts with rerun's facts without accumulating duplicates
      expect(factsRun2.length).toBe(rerunRes.factsExtracted);
      expect(factsRun2.length).toBeGreaterThan(0);
      expect(factsRun2.length).not.toBe(
        factsRun1.length + rerunRes.factsExtracted
      );

      benchmarkMetrics.push({
        action: "Test 5: Full document extract job (text + vision)",
        itemsExtracted: extractRes.factsExtracted,
        tokensEstimated: 1200,
        wallClockMs,
      });
    } finally {
      await subRedis.unsubscribe(`doc:${doc.id}:status`).catch((_err) => {
        // Ignore unsubscribe error
      });
      subRedis.disconnect();

      await db.delete(facts).where(eq(facts.documentId, doc.id));
      await db.delete(pageChunks).where(eq(pageChunks.documentId, doc.id));
      await db.delete(documents).where(eq(documents.id, doc.id));
    }
  }, 180_000);

  test("Test 6: Vision: rendered table image -> >= 1 fact with visionOnly: true, PNG exists on disk", async () => {
    geminiVisionCallCount++;
    if (geminiVisionCallCount > COST_CAPS.maxGeminiVisionCalls) {
      throw new Error(
        `Cost cap exceeded: max ${COST_CAPS.maxGeminiVisionCalls} vision calls allowed.`
      );
    }

    const testDocId = `test_vision_${Date.now()}`;
    const t0 = Date.now();

    const imagePath = await renderPageImage(testDocId, 2, fixturePdfPath);
    expect(existsSync(imagePath)).toBe(true);

    const dataUrl = await imagePathToDataUrl(imagePath);
    expect(dataUrl.startsWith("data:image/png;base64,")).toBe(true);

    const rawFacts = await extractVisionPage(
      dataUrl,
      "Financial Summary Table - FY2023 vs FY2022"
    );
    const wallClockMs = Date.now() - t0;

    expect(rawFacts.length).toBeGreaterThanOrEqual(1);

    const validated = rawFacts.map((f) => applyQuoteValidation(f, "", true));
    for (const { fact, sourceQuoteValid, visionOnly } of validated) {
      expect(visionOnly).toBe(true);
      expect(sourceQuoteValid).toBe(false);
      expect(typeof fact.predicate).toBe("string");
      expect(typeof fact.value).toBe("string");
    }

    // Clean up rendered image directory
    const imgDir = dirname(imagePath);
    rmSync(imgDir, { force: true, recursive: true });

    benchmarkMetrics.push({
      action: "Test 6: Gemini 3.5 Flash Lite table vision extraction",
      itemsExtracted: rawFacts.length,
      tokensEstimated: 800,
      wallClockMs,
    });
  }, 45_000);

  test("Test 7: Log wall-clock ms and token count", () => {
    console.log("\n=======================================================");
    console.log("            PHASE-2 EXTRACTION BENCHMARKS              ");
    console.log("=======================================================");
    console.table(
      benchmarkMetrics.map((m) => ({
        Action: m.action,
        "Est. Tokens": m.tokensEstimated,
        "Facts Extracted": m.itemsExtracted,
        "Wall-Clock (ms)": m.wallClockMs,
      }))
    );
    console.log("=======================================================\n");

    expect(benchmarkMetrics.length).toBeGreaterThanOrEqual(4);
  });
});
