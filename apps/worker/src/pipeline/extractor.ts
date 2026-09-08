import { type ExtractedFact, ExtractionResultSchema } from "@grounded/db";

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

export interface QuoteValidationResult {
  fact: ExtractedFact;
  sourceQuoteValid: boolean;
  visionOnly?: boolean;
}

export const applyQuoteValidation = (
  fact: ExtractedFact,
  sourceText: string,
  visionOnly: boolean
): QuoteValidationResult => {
  if (visionOnly) {
    const qualifiers = Array.isArray(fact.qualifiers)
      ? [
          ...fact.qualifiers.filter((q) => q.key !== "visionOnly"),
          { key: "visionOnly", value: "true" },
        ]
      : {
          ...(fact.qualifiers as Record<string, string> | null),
          visionOnly: "true",
        };

    return {
      fact: {
        ...fact,
        qualifiers: qualifiers as ExtractedFact["qualifiers"],
      },
      sourceQuoteValid: true,
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

  const qualifiers = Array.isArray(fact.qualifiers)
    ? [
        ...fact.qualifiers.filter((q) => q.key !== "quoteMismatch"),
        { key: "quoteMismatch", value: "true" },
      ]
    : {
        ...(fact.qualifiers as Record<string, string> | null),
        quoteMismatch: "true",
      };

  return {
    fact: {
      ...fact,
      confidence: Number((fact.confidence * 0.5).toFixed(4)),
      qualifiers: qualifiers as ExtractedFact["qualifiers"],
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
    const parsed: unknown = JSON.parse(raw);
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

export const assessChunk = (
  chunk: ChunkForAssessment
):
  | "extract-text"
  | "extract-vision"
  | "skip-empty"
  | "defer-vision-disabled" => {
  const isTextEmpty = chunk.rawText.trim().length === 0;
  const hasNoRuns =
    !chunk.runs || (Array.isArray(chunk.runs) && chunk.runs.length === 0);

  if (isTextEmpty && hasNoRuns) {
    return "skip-empty";
  }

  const needsVision = Boolean(
    chunk.needsVision || chunk.isTableHeavy || chunk.isLowText
  );

  if (needsVision) {
    if (process.env.VISION_ENABLED !== "1") {
      return "defer-vision-disabled";
    }
    return "extract-vision";
  }

  return "extract-text";
};
