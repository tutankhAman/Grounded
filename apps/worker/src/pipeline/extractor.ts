import { createHash } from "node:crypto";
import {
  type BatchExtractedFact,
  BatchExtractionResultSchema,
  type ExtractedFact,
  ExtractionResultSchema,
} from "@grounded/db";

const MARKDOWN_CODE_PREFIX_REGEX = /^```(?:json)?\s*/i;
const MARKDOWN_CODE_SUFFIX_REGEX = /```$/;

export const EXTRACTION_SYSTEM_PROMPT = `You are a precise fact extractor. Your only job is to identify and extract discrete factual claims from the provided document chunk.
Rules:
1. Extract only facts that are explicitly stated, not inferred.
2. sourceQuote must be an exact, verbatim substring of the chunk text — copy-paste, do not paraphrase.
3. predicate should be a snake_case label describing the relationship (e.g. "annual_revenue", "employee_count").
4. factTypeDescription should describe the category of fact in one sentence, generalizable to other documents.
5. Set confidence below 0.7 if the fact comes from a table whose layout you cannot fully interpret, or if the scope (time, geography, segment) is ambiguous.
6. If a chunk contains no extractable facts, return {"facts": []}.`;

export const validateQuote = (
  fact: { sourceQuote: string },
  sourceText: string
): boolean => {
  const quote = fact.sourceQuote.trim();
  if (!quote || quote.length === 0) {
    return false;
  }
  return sourceText.includes(quote);
};

export interface QuoteValidationResult<
  T extends ExtractedFact = ExtractedFact,
> {
  fact: T;
  sourceQuoteValid: boolean;
  visionOnly: boolean;
}

export const applyQuoteValidation = <T extends ExtractedFact>(
  fact: T,
  sourceText: string,
  isVisionOnly = false
): QuoteValidationResult<T> => {
  if (isVisionOnly) {
    const qualifiers: Record<string, unknown> = {
      ...(fact.qualifiers ?? {}),
      visionOnly: true,
    };

    return {
      fact: {
        ...fact,
        qualifiers,
      },
      sourceQuoteValid: false,
      visionOnly: true,
    };
  }

  const valid = validateQuote(fact, sourceText);
  if (valid) {
    return {
      fact,
      sourceQuoteValid: true,
      visionOnly: false,
    };
  }

  const qualifiers: Record<string, unknown> = {
    ...(fact.qualifiers ?? {}),
    quoteMismatch: true,
  };

  return {
    fact: {
      ...fact,
      confidence: Number((fact.confidence * 0.5).toFixed(4)),
      qualifiers,
    },
    sourceQuoteValid: false,
    visionOnly: false,
  };
};

export const buildEmbeddingInput = (fact: {
  entity: { name: string };
  predicate: string;
  value: string;
}): string => `fact: ${fact.entity.name} ${fact.predicate} ${fact.value}`;

export const parseFallbackOutput = (
  raw: string
): { ok: true; facts: ExtractedFact[] } | { error: string; ok: false } => {
  try {
    const trimmed = raw
      .trim()
      .replace(MARKDOWN_CODE_PREFIX_REGEX, "")
      .replace(MARKDOWN_CODE_SUFFIX_REGEX, "")
      .trim();
    const parsed: unknown = JSON.parse(trimmed);
    const result = ExtractionResultSchema.safeParse(parsed);
    if (result.success) {
      return { facts: result.data.facts, ok: true };
    }
    return { error: result.error.message, ok: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, ok: false };
  }
};

export const parseFallbackBatchOutput = (
  raw: string
): { ok: true; facts: BatchExtractedFact[] } | { error: string; ok: false } => {
  try {
    const trimmed = raw
      .trim()
      .replace(MARKDOWN_CODE_PREFIX_REGEX, "")
      .replace(MARKDOWN_CODE_SUFFIX_REGEX, "")
      .trim();
    const parsed: unknown = JSON.parse(trimmed);
    const result = BatchExtractionResultSchema.safeParse(parsed);
    if (result.success) {
      return { facts: result.data.facts, ok: true };
    }
    return { error: result.error.message, ok: false };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return { error: message, ok: false };
  }
};

export const decideFactType = (
  bestSimilarity: number | null,
  threshold = 0.85
): "link" | "mint" => {
  if (bestSimilarity !== null && bestSimilarity >= threshold) {
    return "link";
  }
  return "mint";
};

export interface ChunkForAssessment {
  isLowText?: boolean;
  isTableHeavy?: boolean;
  needsVision?: boolean;
  rawText: string;
  runs?: unknown[];
}

/**
 * Assesses how a page chunk should be routed:
 * - isLowText (and vision enabled) -> "extract-vision"
 * - isLowText (and vision disabled) -> "skip"
 * - isTableHeavy -> "extract-text-table" (table-heavy pages go text-first)
 * - empty text and runs -> "skip"
 * - default -> "extract-text"
 */
export const assessChunk = (
  chunk: ChunkForAssessment,
  visionEnabled: boolean = process.env.VISION_ENABLED !== "0"
):
  | "defer-vision-disabled"
  | "extract-text"
  | "extract-text-table"
  | "extract-vision"
  | "skip" => {
  const isTextEmpty = chunk.rawText.trim().length === 0;
  const hasNoRuns =
    !chunk.runs || (Array.isArray(chunk.runs) && chunk.runs.length === 0);

  if (isTextEmpty && hasNoRuns) {
    return "skip";
  }

  const isLowText = Boolean(chunk.isLowText);
  if (isLowText) {
    return visionEnabled ? "extract-vision" : "defer-vision-disabled";
  }

  if (chunk.isTableHeavy) {
    return "extract-text-table";
  }

  return "extract-text";
};

export interface PageToPack {
  isLowText?: boolean;
  isTableHeavy?: boolean;
  pageNumber: number;
  text: string;
  tokenEstimate?: number;
}

/**
 * Estimates output tokens generated by fact extraction for a single page.
 */
export const estimatePageOutputTokens = (page: PageToPack): number => {
  const inputTokens = page.tokenEstimate ?? Math.ceil(page.text.length / 4);
  return Math.max(1500, Math.round(inputTokens * 1.5));
};

/**
 * Order-preserving packing of pages into batches under targetOutputTokens.
 * Small documents collapse into 1 batch. An oversize loner gets its own batch.
 */
export const packPages = (
  pages: PageToPack[],
  targetOutputTokens = 42_000
): PageToPack[][] => {
  if (pages.length === 0) {
    return [];
  }

  const batches: PageToPack[][] = [];
  let currentBatch: PageToPack[] = [];
  let currentTokens = 0;

  for (const page of pages) {
    const pageOutputTokens = estimatePageOutputTokens(page);

    // Oversize page gets its own dedicated batch
    if (pageOutputTokens >= targetOutputTokens) {
      if (currentBatch.length > 0) {
        batches.push(currentBatch);
        currentBatch = [];
        currentTokens = 0;
      }
      batches.push([page]);
      continue;
    }

    if (
      currentBatch.length > 0 &&
      currentTokens + pageOutputTokens > targetOutputTokens
    ) {
      batches.push(currentBatch);
      currentBatch = [page];
      currentTokens = pageOutputTokens;
    } else {
      currentBatch.push(page);
      currentTokens += pageOutputTokens;
    }
  }

  if (currentBatch.length > 0) {
    batches.push(currentBatch);
  }

  return batches;
};

/**
 * Computes first 16 hex characters of SHA-256 hash of page text for deduplication.
 */
export const hashPage = (text: string): string =>
  createHash("sha256").update(text).digest("hex").slice(0, 16);

/**
 * Finds repeated chrome strings (headers/footers/boilerplate) appearing on >50% of pages.
 */
export const findRepeatedStrings = (
  pages: Array<{ text: string }>
): string[] => {
  if (pages.length <= 1) {
    return [];
  }

  const lineOccurrences = new Map<string, number>();
  const threshold = Math.floor(pages.length / 2) + 1;

  for (const page of pages) {
    const lines = new Set(
      page.text
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.length > 5)
    );
    for (const line of lines) {
      lineOccurrences.set(line, (lineOccurrences.get(line) ?? 0) + 1);
    }
  }

  const repeated: string[] = [];
  for (const [line, count] of lineOccurrences.entries()) {
    if (count >= threshold) {
      repeated.push(line);
    }
  }
  return repeated;
};

/**
 * Strips repeated header/footer strings across pages to compact text and save token budget.
 */
export const compactText = (
  text: string,
  repeatedStrings: string[]
): string => {
  if (repeatedStrings.length === 0) {
    return text;
  }
  let result = text;
  for (const str of repeatedStrings) {
    result = result.replaceAll(str, "");
  }
  return result.replace(/\n{3,}/g, "\n\n").trim();
};

/**
 * Validates batch results by ensuring facts have page numbers matching pages in the batch.
 * Drops facts with invented page numbers outside the batch.
 */
export const validateBatchResult = (
  facts: BatchExtractedFact[],
  allowedPageNumbers: Set<number>
): { droppedCount: number; validFacts: BatchExtractedFact[] } => {
  const validFacts: BatchExtractedFact[] = [];
  let droppedCount = 0;

  for (const fact of facts) {
    if (allowedPageNumbers.has(fact.pageNumber)) {
      validFacts.push(fact);
    } else {
      droppedCount++;
    }
  }

  return { droppedCount, validFacts };
};

/**
 * Splits a batch in half for retry when an extraction call fails or output is too large.
 */
export const splitBatch = <T>(batch: T[]): [T[], T[]] => {
  if (batch.length <= 1) {
    return [batch, []];
  }
  const mid = Math.ceil(batch.length / 2);
  return [batch.slice(0, mid), batch.slice(mid)];
};
