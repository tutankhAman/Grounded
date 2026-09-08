import { describe, expect, test } from "bun:test";
import type { BatchExtractedFact } from "@grounded/db";
import { TokenBucketRateLimiter } from "../lib/rate-limit";
import {
  applyQuoteValidation,
  assessChunk,
  compactText,
  findRepeatedStrings,
  hashPage,
  packPages,
  splitBatch,
  validateBatchResult,
} from "../pipeline/extractor";
import { collectEscalationPages, deduplicatePages } from "./extract";

describe("Phase-2 Extraction Resilience and Pure Logic Unit Tests", () => {
  describe("TokenBucketRateLimiter", () => {
    test("initializes with specified capacity and tokens", () => {
      const limiter = new TokenBucketRateLimiter(60);
      expect(limiter.getAvailableTokens()).toBe(60);
      expect(limiter.isPaused()).toBe(false);
    });

    test("pauses on handle429 with retry-after header", () => {
      const limiter = new TokenBucketRateLimiter(60);
      const pauseMs = limiter.handle429("2.5");
      expect(pauseMs).toBeGreaterThanOrEqual(2500);
      expect(limiter.isPaused()).toBe(true);
    });

    test("parses retry in Xs from error message body", () => {
      const limiter = new TokenBucketRateLimiter(60);
      const pauseMs = limiter.handle429(
        undefined,
        "Quota exceeded, please retry in 3.2s."
      );
      expect(pauseMs).toBeGreaterThanOrEqual(3200);
      expect(limiter.isPaused()).toBe(true);
    });

    test("exponential backoff increases on consecutive 429s", () => {
      const limiter = new TokenBucketRateLimiter(60);
      const pause1 = limiter.handle429();
      const pause2 = limiter.handle429();
      // pause2 (2^2 = 4s base) should exceed pause1 (2^1 = 2s base)
      expect(pause2).toBeGreaterThan(pause1);
    });

    test("recordSuccess reduces consecutive 429 counter", () => {
      const limiter = new TokenBucketRateLimiter(60);
      limiter.handle429();
      limiter.recordSuccess();
      limiter.recordSuccess();
      // Should not throw or error
      expect(limiter.getAvailableTokens()).toBeGreaterThan(0);
    });
  });

  describe("Batch packing and resilience", () => {
    test("packPages collapses small documents into a single batch", () => {
      const pages = [
        { pageNumber: 1, text: "Page 1 content", tokenEstimate: 200 },
        { pageNumber: 2, text: "Page 2 content", tokenEstimate: 250 },
        { pageNumber: 3, text: "Page 3 content", tokenEstimate: 300 },
      ];

      const batches = packPages(pages, 42_000);
      expect(batches.length).toBe(1);
      expect(batches[0].length).toBe(3);
      expect(batches[0].map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    });

    test("packPages splits dense documents into multiple batches under budget", () => {
      // 10 dense pages each estimated at 10,000 output tokens
      const pages = Array.from({ length: 10 }, (_, i) => ({
        pageNumber: i + 1,
        text: `Dense content for page ${i + 1}`,
        tokenEstimate: 7000,
      }));

      const targetBudget = 30_000;
      const batches = packPages(pages, targetBudget);
      expect(batches.length).toBeGreaterThan(1);

      // Verify all pages are preserved in sequential order
      const allPages = batches.flatMap((b) => b.map((p) => p.pageNumber));
      expect(allPages).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    });

    test("splitBatch splits an array into two halves for retry", () => {
      const [left, right] = splitBatch([1, 2, 3, 4]);
      expect(left).toEqual([1, 2]);
      expect(right).toEqual([3, 4]);

      const [singleLeft, singleRight] = splitBatch([42]);
      expect(singleLeft).toEqual([42]);
      expect(singleRight).toEqual([]);
    });

    test("validateBatchResult drops facts with hallucinated page numbers", () => {
      const mockFacts = [
        {
          confidence: 0.9,
          entity: { context: "ctx", name: "A", type: "T" },
          factTypeDescription: "desc",
          pageNumber: 1,
          predicate: "p1",
          qualifiers: {},
          rawValue: "v1",
          sourceQuote: "q1",
          value: "v1",
        },
        {
          confidence: 0.9,
          entity: { context: "ctx", name: "B", type: "T" },
          factTypeDescription: "desc",
          pageNumber: 99, // Hallucinated page number
          predicate: "p2",
          qualifiers: {},
          rawValue: "v2",
          sourceQuote: "q2",
          value: "v2",
        },
      ];

      const allowed = new Set([1, 2]);
      const { droppedCount, validFacts } = validateBatchResult(
        mockFacts,
        allowed
      );
      expect(droppedCount).toBe(1);
      expect(validFacts.length).toBe(1);
      expect(validFacts[0].predicate).toBe("p1");
    });
  });

  describe("Chrome stripping and deduplication", () => {
    test("findRepeatedStrings identifies headers/footers appearing across pages", () => {
      const pages = [
        { text: "Confidential - Company ABC\nPage 1 text\nCopyright 2024" },
        { text: "Confidential - Company ABC\nPage 2 text\nCopyright 2024" },
        { text: "Confidential - Company ABC\nPage 3 text\nCopyright 2024" },
      ];

      const repeated = findRepeatedStrings(pages);
      expect(repeated).toContain("Confidential - Company ABC");
      expect(repeated).toContain("Copyright 2024");
    });

    test("compactText strips repeated strings", () => {
      const text =
        "Confidential - Company ABC\nFinancial summary data here\nCopyright 2024";
      const stripped = compactText(text, [
        "Confidential - Company ABC",
        "Copyright 2024",
      ]);
      expect(stripped).toBe("Financial summary data here");
    });

    test("hashPage produces deterministic 16-hex characters", () => {
      const h1 = hashPage("Same text");
      const h2 = hashPage("Same text");
      const h3 = hashPage("Different text");

      expect(h1).toBe(h2);
      expect(h1).not.toBe(h3);
      expect(h1.length).toBe(16);
    });

    test("assessChunk routes table-heavy pages to extract-text-table (text-first)", () => {
      const decision = assessChunk({
        isLowText: false,
        isTableHeavy: true,
        rawText: "Table content with numbers",
      });
      expect(decision).toBe("extract-text-table");
    });

    test("assessChunk routes low-text with vision disabled to defer-vision-disabled", () => {
      const decision = assessChunk(
        {
          isLowText: true,
          rawText: "Short text",
        },
        false
      );
      expect(decision).toBe("defer-vision-disabled");
    });

    test("deduplicatePages bypasses boilerplate stripping and dedup when skipBoilerplate is false", () => {
      const samplePages = [
        {
          chunkIds: ["c1"],
          firstChunkIndex: 0,
          isLowText: false,
          isTableHeavy: false,
          needsVision: false,
          pageNumber: 1,
          rawText: "Header line\nPage 1 content\nFooter line",
          tokenEstimate: 50,
        },
        {
          chunkIds: ["c2"],
          firstChunkIndex: 1,
          isLowText: false,
          isTableHeavy: false,
          needsVision: false,
          pageNumber: 2,
          rawText: "Header line\nPage 2 content\nFooter line",
          tokenEstimate: 50,
        },
        {
          chunkIds: ["c3"],
          firstChunkIndex: 2,
          isLowText: false,
          isTableHeavy: false,
          needsVision: false,
          pageNumber: 3,
          rawText: "Header line\nPage 3 content\nFooter line",
          tokenEstimate: 50,
        },
        {
          chunkIds: ["c4"],
          firstChunkIndex: 3,
          isLowText: false,
          isTableHeavy: false,
          needsVision: false,
          pageNumber: 4,
          rawText: "Header line\nPage 1 content\nFooter line",
          tokenEstimate: 50,
        },
      ];

      // When skipBoilerplate = false:
      const bypassed = deduplicatePages(samplePages, false);
      expect(bypassed.duplicatePageMap.size).toBe(0);
      expect(bypassed.uniquePages.length).toBe(4);
      expect(bypassed.uniquePages[0].compactedText).toBe(
        "Header line\nPage 1 content\nFooter line"
      );

      // When skipBoilerplate = true:
      const active = deduplicatePages(samplePages, true);
      expect(active.uniquePages.length).toBe(3);
      expect(active.duplicatePageMap.get(4)).toBe(1);
      expect(active.uniquePages[0].compactedText).toBe("Page 1 content");
    });

    test("applyQuoteValidation retains valid quotes on text facts even on escalated pages", () => {
      const pageRawText =
        "The company reported net revenue of $50 million for the quarter.";

      const textFact: BatchExtractedFact = {
        confidence: 0.95,
        entity: { context: "The company context", name: "Acme", type: "org" },
        factTypeDescription: "financial metric",
        pageNumber: 1,
        predicate: "revenue",
        qualifiers: {},
        rawValue: "$50 million",
        sourceQuote: "net revenue of $50 million",
        value: "50000000",
        viaVision: false,
      };

      const visionFact: BatchExtractedFact = {
        confidence: 0.85,
        entity: { context: "The company context", name: "Acme", type: "org" },
        factTypeDescription: "financial metric",
        pageNumber: 1,
        predicate: "ebitda",
        qualifiers: {},
        rawValue: "$15M",
        sourceQuote: "from table cell 3",
        value: "15000000",
        viaVision: true,
      };

      const validatedText = applyQuoteValidation(
        textFact,
        pageRawText,
        Boolean(textFact.viaVision)
      );
      expect(validatedText.sourceQuoteValid).toBe(true);
      expect(validatedText.fact.confidence).toBe(0.95);
      expect(validatedText.fact.qualifiers.visionOnly).toBeUndefined();

      const validatedVision = applyQuoteValidation(
        visionFact,
        pageRawText,
        Boolean(visionFact.viaVision)
      );
      expect(validatedVision.sourceQuoteValid).toBe(false);
      expect(validatedVision.fact.qualifiers.visionOnly).toBe(true);
    });

    test("collectEscalationPages selects only weak table-heavy pages", () => {
      const pageMap = new Map([
        [
          1,
          {
            chunkIds: ["c1"],
            firstChunkIndex: 0,
            isLowText: false,
            isTableHeavy: true,
            needsVision: false,
            pageNumber: 1,
            rawText: "table",
          },
        ],
        [
          2,
          {
            chunkIds: ["c2"],
            firstChunkIndex: 1,
            isLowText: false,
            isTableHeavy: true,
            needsVision: false,
            pageNumber: 2,
            rawText: "table",
          },
        ],
        [
          3,
          {
            chunkIds: ["c3"],
            firstChunkIndex: 2,
            isLowText: false,
            isTableHeavy: false,
            needsVision: false,
            pageNumber: 3,
            rawText: "prose",
          },
        ],
      ]);
      const batch = [
        { pageNumber: 1, text: "table" },
        { pageNumber: 2, text: "table" },
        { pageNumber: 3, text: "prose" },
      ];
      const strongFact: BatchExtractedFact = {
        confidence: 0.9,
        entity: { context: "c", name: "Acme", type: "org" },
        factTypeDescription: "metric",
        pageNumber: 1,
        predicate: "revenue",
        qualifiers: {},
        rawValue: "100",
        sourceQuote: "revenue 100",
        value: "100",
        viaVision: false,
      };
      // Page 1: strong table fact -> no escalation. Page 2: table-heavy with
      // no facts -> escalate. Page 3: not table-heavy -> never escalate.
      const escalations = collectEscalationPages(batch, pageMap, [strongFact]);
      expect(escalations.map((e) => e.pageNumber)).toEqual([2]);

      // All-weak table facts also escalate.
      const weakFact: BatchExtractedFact = { ...strongFact, confidence: 0.5 };
      const escalationsWeak = collectEscalationPages(batch, pageMap, [
        { ...weakFact, pageNumber: 2 },
      ]);
      expect(escalationsWeak.map((e) => e.pageNumber)).toEqual([1, 2]);
    });
  });
});
