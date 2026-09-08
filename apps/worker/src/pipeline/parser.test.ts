import { describe, expect, test } from "bun:test";
import { DEFAULT_THRESHOLDS } from "@grounded/db";
import {
  classifyPage,
  estimateTokens,
  type PageClassification,
  runsFromTextContent,
  splitOversizePage,
  type TextRun,
} from "./parser";

describe("parser pure layer", () => {
  test("estimateTokens calculates expected values", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcdefgh")).toBe(2);
    expect(estimateTokens("a".repeat(400))).toBe(100);
  });

  test("runsFromTextContent maps items and skips empty strings", () => {
    const fixture = {
      items: [
        {
          fontName: "Helvetica-Bold",
          height: 12,
          str: "Delhivery Limited",
          transform: [12, 0, 0, 12, 100, 200],
          width: 80,
        },
        {
          height: 12,
          str: "   ", // empty / whitespace only
          transform: [12, 0, 0, 12, 180, 200],
          width: 10,
        },
        {
          fontName: "Helvetica",
          height: 10,
          str: "₹ 2,076 Cr",
          transform: [10, 0, 0, 10, 100, 180],
          width: 50,
        },
      ],
    };

    const { runs, rawText } = runsFromTextContent(1, fixture);

    expect(runs).toHaveLength(2);
    expect(runs[0]).toEqual({
      fontName: "Helvetica-Bold",
      height: 12,
      pageNumber: 1,
      text: "Delhivery Limited",
      width: 80,
      x: 100,
      y: 200,
    });
    expect(runs[1].text).toBe("₹ 2,076 Cr");
    expect(rawText).toBe("Delhivery Limited ₹ 2,076 Cr");
  });

  test("classifyPage correctly identifies table-heavy pages", () => {
    // 20 items (exceeds min 15 items), 12 numeric (60%), average width 30 on 600px width page
    const runs: TextRun[] = Array.from({ length: 20 }, (_, i) => ({
      fontName: "Font",
      height: 10,
      pageNumber: 1,
      text: i < 12 ? "123.45" : "Revenue item label",
      width: 30,
      x: 50,
      y: 200 - i * 10,
    }));

    const rawText =
      "A long narrative text that exceeds the low text threshold ".repeat(20);
    const classification = classifyPage(runs, rawText, 600, DEFAULT_THRESHOLDS);

    expect(classification.isTableHeavy).toBe(true);
    expect(classification.isLowText).toBe(false);
    expect(classification.visionFlagged).toBe(true);
  });

  test("classifyPage correctly identifies dense narrative text pages", () => {
    // 50 items, mostly words, wide columns
    const runs: TextRun[] = Array.from({ length: 50 }, (_, i) => ({
      fontName: "Font",
      height: 10,
      pageNumber: 1,
      text: "The financial results for the quarter ended March 31, 2024 were approved.",
      width: 400,
      x: 50,
      y: 700 - i * 12,
    }));

    const rawText = runs.map((r) => r.text).join(" ");
    const classification = classifyPage(runs, rawText, 600, DEFAULT_THRESHOLDS);

    expect(classification.isTableHeavy).toBe(false);
    expect(classification.isLowText).toBe(false);
    expect(classification.visionFlagged).toBe(false);
  });

  test("classifyPage flags low-text or scanned pages", () => {
    const runs: TextRun[] = [
      {
        fontName: "Font",
        height: 20,
        pageNumber: 1,
        text: "Title only",
        width: 100,
        x: 100,
        y: 500,
      },
    ];

    const classification = classifyPage(
      runs,
      "Title only",
      600,
      DEFAULT_THRESHOLDS
    );
    expect(classification.isLowText).toBe(true);
    expect(classification.visionFlagged).toBe(true);
  });

  test("classifyPage handles empty page cleanly", () => {
    const classification = classifyPage([], "", 600, DEFAULT_THRESHOLDS);
    expect(classification.isLowText).toBe(true);
    expect(classification.isTableHeavy).toBe(false);
    expect(classification.visionFlagged).toBe(true);
  });

  test("splitOversizePage keeps normal pages as single chunk", () => {
    const runs: TextRun[] = [
      {
        fontName: "F",
        height: 10,
        pageNumber: 1,
        text: "Hello",
        width: 20,
        x: 0,
        y: 10,
      },
      {
        fontName: "F",
        height: 10,
        pageNumber: 1,
        text: "World",
        width: 20,
        x: 0,
        y: 0,
      },
    ];
    const classification: PageClassification = {
      avgWidth: 20,
      isLowText: false,
      isTableHeavy: false,
      numericRatio: 0,
      visionFlagged: false,
    };

    const chunks = splitOversizePage(
      runs,
      1,
      "Hello World",
      classification,
      DEFAULT_THRESHOLDS
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].rawText).toBe("Hello World");
  });

  test("splitOversizePage splits pages exceeding token threshold", () => {
    // Generate a long text exceeding 6000 tokens (e.g. 30,000 characters)
    const longPiece = "Lorem ipsum dolor sit amet ".repeat(10); // ~270 chars
    const runs: TextRun[] = Array.from({ length: 120 }, (_, i) => ({
      fontName: "F",
      height: 10,
      pageNumber: 1,
      text: longPiece,
      width: 400,
      x: 50,
      y: 1000 - i * 20, // vertical gaps
    }));

    const rawText = runs.map((r) => r.text).join(" ");
    const classification: PageClassification = {
      avgWidth: 400,
      isLowText: false,
      isTableHeavy: false,
      numericRatio: 0,
      visionFlagged: false,
    };

    const chunks = splitOversizePage(
      runs,
      1,
      rawText,
      classification,
      DEFAULT_THRESHOLDS
    );
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[1].chunkIndex).toBe(1);
  });
});
