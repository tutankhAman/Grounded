import {
  createGoogleGenerativeAI,
  type GoogleEmbeddingModelOptions,
} from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  type BatchExtractedFact,
  BatchExtractionResultSchema,
  EMBEDDING_DIM,
  type EntityConfirm,
  type ReconciliationResult,
  ReconciliationResultSchema,
} from "@grounded/db";
import { embedMany, generateObject, generateText } from "ai";
import { rateLimitedFetch } from "../lib/rate-limit";
import {
  EXTRACTION_SYSTEM_PROMPT,
  parseFallbackBatchOutput,
} from "./extractor";
import {
  buildJudgePrompt,
  type FactDetail,
  parseJudgeResponse,
} from "./reconciler";
import { buildEntityConfirmPrompt, parseConfirmResponse } from "./resolver";

export class ExtractionFailedError extends Error {
  readonly rawOutput?: string;

  constructor(
    message: string,
    options?: { cause?: unknown; rawOutput?: string }
  ) {
    super(message, { cause: options?.cause });
    this.name = "ExtractionFailedError";
    this.rawOutput = options?.rawOutput;
  }
}

/**
 * Single gateway-routed OpenAI-compatible chat provider.
 * Uses LLM_BASE_URL (defaults to Gemini OpenAI-compatible endpoint) and LLM_API_KEY.
 * Falls back to GEMINI_API_KEY if LLM_API_KEY is not explicitly set.
 */
export const getChatProvider = () => {
  const baseURL =
    process.env.LLM_BASE_URL ||
    "https://generativelanguage.googleapis.com/v1beta/openai/";
  const apiKey = process.env.LLM_API_KEY || process.env.GEMINI_API_KEY || "";
  if (!apiKey) {
    throw new Error(
      "Either LLM_API_KEY or GEMINI_API_KEY is required for LLM chat and extraction."
    );
  }
  return createOpenAI({
    apiKey,
    baseURL,
    fetch: rateLimitedFetch,
  });
};

/**
 * Direct Google provider retained strictly as an env-switchable fallback (EMBED_DIRECT=1).
 */
export const getDirectGoogleProvider = () => {
  const apiKey = process.env.GEMINI_API_KEY || process.env.LLM_API_KEY;
  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is required for direct Google embedding.");
  }
  return createGoogleGenerativeAI({
    apiKey,
    fetch: rateLimitedFetch,
  });
};

export interface PageBatchItem {
  pageNumber: number;
  text: string;
}

export const formatBatchPrompt = (pages: PageBatchItem[]): string =>
  pages.map((p) => `--- PAGE ${p.pageNumber} ---\n${p.text}`).join("\n\n");

/**
 * L2-normalize an embedding vector to unit length (||v|| = 1.0).
 * Required because gemini-embedding-001 does not auto-normalize when truncated to 1536 dims.
 */
export const l2Normalize = (vector: number[]): number[] => {
  let sumSq = 0;
  for (const v of vector) {
    sumSq += v * v;
  }
  const norm = Math.sqrt(sumSq);
  if (norm === 0) {
    return vector;
  }
  return vector.map((v) => v / norm);
};

export interface ExtractBatchOptions {
  forceFailure?: boolean;
  systemPrompt?: string;
}

/**
 * Extracts facts across a batch of pages using native structured output.
 * Each fact carries its respective 1-based pageNumber.
 */
export const extractBatch = async (
  pages: PageBatchItem[],
  options?: ExtractBatchOptions
): Promise<BatchExtractedFact[]> => {
  if (options?.forceFailure) {
    throw new ExtractionFailedError("Forced extraction failure for testing.");
  }
  if (pages.length === 0) {
    return [];
  }

  const provider = getChatProvider();
  const modelName = process.env.TEXT_MODEL ?? "gemini-3.5-flash-lite";
  const model = provider(modelName);
  const systemPrompt = options?.systemPrompt ?? EXTRACTION_SYSTEM_PROMPT;
  const thinkingBudget = Number(process.env.THINKING_BUDGET ?? 0);

  const promptText = `Extract all facts from the following document pages. Each fact MUST include the 1-based pageNumber corresponding to the page section header (e.g. --- PAGE X ---) where the fact is stated:\n\n${formatBatchPrompt(
    pages
  )}`;

  try {
    const result = await generateObject({
      maxRetries: 2,
      model,
      prompt: promptText,
      // Best-effort thinking budget (proxies or non-Gemini gateways may strip it)
      providerOptions: {
        google: {
          thinking: {
            budgetTokens: thinkingBudget,
          },
        },
      },
      schema: BatchExtractionResultSchema,
      system: systemPrompt,
      temperature: 0,
    });
    return result.object.facts;
  } catch (schemaErr: unknown) {
    try {
      const rawResult = await generateText({
        maxRetries: 2,
        model,
        prompt: `${promptText}\n\nReturn ONLY a valid JSON object matching {"facts": [{"pageNumber": 1, ...}]}.`,
        system: systemPrompt,
        temperature: 0,
      });

      const parsed = parseFallbackBatchOutput(rawResult.text);
      if (parsed.ok) {
        return parsed.facts;
      }
      throw new ExtractionFailedError(
        `Failed to parse batch fallback output: ${parsed.error}`,
        { cause: schemaErr, rawOutput: rawResult.text }
      );
    } catch (fallbackErr: unknown) {
      if (fallbackErr instanceof ExtractionFailedError) {
        throw fallbackErr;
      }
      const message =
        fallbackErr instanceof Error
          ? fallbackErr.message
          : String(fallbackErr);
      throw new ExtractionFailedError(`Batch extraction failed: ${message}`, {
        cause: fallbackErr,
      });
    }
  }
};

/**
 * Single-chunk extraction wrapper preserving backward compatibility.
 * Delegates to extractBatch for page 1.
 */
export const extractTextChunk = async (
  rawText: string,
  options?: ExtractBatchOptions
): Promise<BatchExtractedFact[]> => {
  const batch = await extractBatch([{ pageNumber: 1, text: rawText }], options);
  return batch;
};

function normalizeVisionArgs(
  imagesOrDataUrl: string[] | string,
  pageNumbersOrHint?: number[] | string,
  maybeHint?: string
): { hint?: string; images: string[]; pageNumbers: number[] } {
  if (typeof imagesOrDataUrl === "string") {
    return {
      hint:
        typeof pageNumbersOrHint === "string" ? pageNumbersOrHint : maybeHint,
      images: [imagesOrDataUrl],
      pageNumbers: [1],
    };
  }
  return {
    hint: maybeHint,
    images: imagesOrDataUrl,
    pageNumbers: Array.isArray(pageNumbersOrHint) ? pageNumbersOrHint : [1],
  };
}

type VisionContentPart =
  | { data: string; mediaType: string; type: "file" }
  | { text: string; type: "text" };

async function handleVisionFallback(
  model: Parameters<typeof generateText>[0]["model"],
  contentParts: VisionContentPart[],
  schemaErr: unknown
): Promise<BatchExtractedFact[]> {
  try {
    const rawResult = await generateText({
      maxRetries: 2,
      messages: [
        {
          content: contentParts,
          role: "user",
        },
      ],
      model,
      system: EXTRACTION_SYSTEM_PROMPT,
      temperature: 0,
    });

    const fallback = parseFallbackBatchOutput(rawResult.text);
    if (fallback.ok) {
      return fallback.facts;
    }
    throw new ExtractionFailedError(
      `Vision fallback JSON parse failed: ${fallback.error}`,
      { cause: schemaErr, rawOutput: rawResult.text }
    );
  } catch (fallbackErr: unknown) {
    if (fallbackErr instanceof ExtractionFailedError) {
      throw fallbackErr;
    }
    const message =
      fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
    throw new ExtractionFailedError(
      `Vision batch extraction failed: ${message}`,
      {
        cause: fallbackErr,
        rawOutput: schemaErr instanceof Error ? schemaErr.message : undefined,
      }
    );
  }
}

/**
 * Multi-image or single-image vision extraction with ordering instructions.
 */
export function extractVisionPage(
  imageDataUrl: string,
  rawTextHint?: string
): Promise<BatchExtractedFact[]>;
export function extractVisionPage(
  images: string[],
  pageNumbers: number[],
  hint?: string
): Promise<BatchExtractedFact[]>;
export async function extractVisionPage(
  imagesOrDataUrl: string[] | string,
  pageNumbersOrHint?: number[] | string,
  maybeHint?: string
): Promise<BatchExtractedFact[]> {
  const { hint, images, pageNumbers } = normalizeVisionArgs(
    imagesOrDataUrl,
    pageNumbersOrHint,
    maybeHint
  );

  if (images.length === 0 || pageNumbers.length === 0) {
    return [];
  }

  const provider = getChatProvider();
  const visionModelName = process.env.VISION_MODEL ?? "gemini-3.5-flash-lite";
  const model = provider(visionModelName);
  const thinkingBudget = Number(process.env.THINKING_BUDGET ?? 0);

  const orderingGuide = pageNumbers
    .map((p, idx) => `Image ${idx + 1} corresponds to page ${p}`)
    .join(", ");

  const promptText = hint
    ? `Extract all facts visible in these pages/tables.\nImages provided: ${orderingGuide}.\nEvery extracted fact MUST include the correct pageNumber.\nContext text:\n${hint}`
    : `Extract all facts visible in these pages/tables.\nImages provided: ${orderingGuide}.\nEvery extracted fact MUST include the correct pageNumber.`;

  const contentParts: Array<
    | { type: "file"; data: string; mediaType: string }
    | { type: "text"; text: string }
  > = images.map((imageDataUrl) => ({
    data: imageDataUrl,
    mediaType: "image/png",
    type: "file" as const,
  }));
  contentParts.push({ text: promptText, type: "text" });

  try {
    const result = await generateObject({
      maxRetries: 2,
      messages: [
        {
          content: contentParts,
          role: "user",
        },
      ],
      model,
      providerOptions: {
        google: {
          thinking: {
            budgetTokens: thinkingBudget,
          },
        },
      },
      schema: BatchExtractionResultSchema,
      system: EXTRACTION_SYSTEM_PROMPT,
      temperature: 0,
    });
    return result.object.facts;
  } catch (schemaErr: unknown) {
    return await handleVisionFallback(model, contentParts, schemaErr);
  }
}

const embeddingCache = new Map<string, number[]>();
const MAX_CACHE_SIZE = 5000;
const RETRY_AFTER_REGEX = /retry in ([0-9.]+)s/i;

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const setInEmbeddingCache = (key: string, value: number[]) => {
  if (embeddingCache.size >= MAX_CACHE_SIZE) {
    const firstKey = embeddingCache.keys().next().value;
    if (firstKey !== undefined) {
      embeddingCache.delete(firstKey);
    }
  }
  embeddingCache.set(key, value);
};

const embedWithRetry = async (
  model: Parameters<typeof embedMany>[0]["model"],
  providerOptions: Parameters<typeof embedMany>[0]["providerOptions"],
  values: string[],
  retries = 3
): Promise<number[][]> => {
  let attempt = 0;
  let delayMs = 1500;

  while (attempt < retries) {
    try {
      const result = await embedMany({
        model,
        providerOptions,
        values,
      });
      return result.embeddings;
    } catch (err: unknown) {
      attempt++;
      const errMsg = err instanceof Error ? err.message : String(err);
      const isRateLimit =
        errMsg.includes("Quota exceeded") ||
        errMsg.includes("429") ||
        errMsg.includes("RESOURCE_EXHAUSTED");

      if (isRateLimit && attempt < retries) {
        const match = errMsg.match(RETRY_AFTER_REGEX);
        const waitTime = match
          ? Math.min(Math.ceil(Number(match[1])) * 1000 + 500, 35_000)
          : delayMs;
        await delay(waitTime);
        delayMs *= 2;
        continue;
      }
      throw err;
    }
  }
  throw new Error(`Embedding failed after ${retries} attempts.`);
};

const fetchAndCacheMissing = async (
  missingValues: string[],
  customTaskType?: string
): Promise<number[][]> => {
  const modelName = process.env.EMBEDDING_MODEL ?? "gemini-embedding-001";
  const dim = Number(process.env.EMBEDDING_DIM ?? EMBEDDING_DIM);
  const taskType =
    customTaskType ?? process.env.EMBEDDING_TASK_DOC ?? "RETRIEVAL_DOCUMENT";
  const BATCH_SIZE = 100;
  const fetched: number[][] = [];

  const useDirect = process.env.EMBED_DIRECT === "1";

  for (let i = 0; i < missingValues.length; i += BATCH_SIZE) {
    const batch = missingValues.slice(i, i + BATCH_SIZE);

    let rawEmbeddings: number[][];
    if (useDirect) {
      const google = getDirectGoogleProvider();
      rawEmbeddings = await embedWithRetry(
        google.embedding(modelName),
        {
          google: {
            outputDimensionality: dim,
            taskType: taskType as GoogleEmbeddingModelOptions["taskType"],
          } satisfies GoogleEmbeddingModelOptions,
        },
        batch
      );
    } else {
      const provider = getChatProvider();
      rawEmbeddings = await embedWithRetry(
        provider.embedding(modelName),
        {
          openai: {
            dimensions: dim,
            extraBody: {
              dimensions: dim,
              outputDimensionality: dim,
              taskType,
            },
          },
        },
        batch
      );
    }

    // L2-normalize every vector client-side
    for (let j = 0; j < batch.length; j++) {
      const val = batch[j];
      const emb = rawEmbeddings[j];
      if (emb && val) {
        const normalized = l2Normalize(emb);
        const cacheKey = customTaskType ? `${customTaskType}:${val}` : val;
        setInEmbeddingCache(cacheKey, normalized);
        fetched.push(normalized);
      }
    }
  }

  return fetched;
};

export const embedFactBatch = async (
  inputs: string[],
  options?: { taskType?: string }
): Promise<number[][]> => {
  if (inputs.length === 0) {
    return [];
  }

  const results: (number[] | undefined)[] = new Array(inputs.length);
  const missingIndices: number[] = [];
  const missingValues: string[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const text = inputs[i];
    if (!text) {
      continue;
    }
    const cacheKey = options?.taskType ? `${options.taskType}:${text}` : text;
    const cached = embeddingCache.get(cacheKey);
    if (cached) {
      results[i] = cached;
    } else {
      missingIndices.push(i);
      missingValues.push(text);
    }
  }

  if (missingValues.length > 0) {
    const fetched = await fetchAndCacheMissing(
      missingValues,
      options?.taskType
    );
    for (let k = 0; k < missingIndices.length; k++) {
      const origIdx = missingIndices[k];
      const emb = fetched[k];
      if (origIdx !== undefined && emb) {
        results[origIdx] = emb;
      }
    }
  }

  return results as number[][];
};

export const embedSingle = async (input: string): Promise<number[]> => {
  const [embedding] = await embedFactBatch([input]);
  if (!embedding) {
    throw new Error("Failed to generate embedding for input");
  }
  return embedding;
};

/**
 * Cross-document confirmation call using lightweight Flash-Lite with thinkingBudget: 0.
 * Confirms whether two similar entities refer to the same real-world entity.
 */
export const confirmEntityMatch = async (params: {
  contextA?: string | null;
  contextB?: string | null;
  nameA: string;
  nameB: string;
}): Promise<EntityConfirm> => {
  const provider = getChatProvider();
  const modelName = process.env.TEXT_MODEL ?? "gemini-3.5-flash-lite";
  const model = provider(modelName);
  const prompt = buildEntityConfirmPrompt(params);

  const result = await generateText({
    maxRetries: 2,
    model,
    prompt,
    providerOptions: {
      google: {
        thinking: {
          budgetTokens: 0,
        },
      },
    },
    temperature: 0,
  });

  return parseConfirmResponse(result.text);
};

/**
 * Builds canonical fact matching embedding input string:
 * e.g. "fact: Acme Corp revenue $4.2M"
 */
export const buildMatchEmbeddingInput = (fact: {
  entityName?: string | null;
  predicate: string;
  value: string;
}): string => {
  const entityPart = fact.entityName?.trim()
    ? `${fact.entityName.trim()} `
    : "";
  return `fact: ${entityPart}${fact.predicate.trim()} ${fact.value.trim()}`;
};

export interface JudgeFactPairOptions {
  docA?: { filename: string } | null;
  docB?: { filename: string } | null;
  model?: string;
  thinkingBudget?: number;
}

/**
 * Calls LLM judge to classify and explain the relationship between two facts.
 * Falls back to generateText + parser if structured object fails.
 * Never throws away a pair on failure; returns uncertain with explanation.
 */
export const judgeFactPair = async (
  pair: { factA: FactDetail; factB: FactDetail },
  options?: JudgeFactPairOptions
): Promise<ReconciliationResult> => {
  const provider = getChatProvider();
  const modelName =
    options?.model ??
    process.env.JUDGE_MODEL ??
    process.env.TEXT_MODEL ??
    "gemini-3.5-flash-lite";
  const model = provider(modelName);
  const thinkingBudget =
    options?.thinkingBudget ?? Number(process.env.JUDGE_THINKING_BUDGET ?? "0");

  const prompt = buildJudgePrompt({
    docA: options?.docA,
    docB: options?.docB,
    factA: pair.factA,
    factB: pair.factB,
  });

  const system =
    "You are a fact reconciliation judge. Given two facts about the same entity from different documents, determine their relationship and explain it in plain language.";

  try {
    const result = await generateObject({
      maxRetries: 2,
      model,
      prompt,
      providerOptions: {
        google: {
          thinking: {
            budgetTokens: thinkingBudget,
          },
        },
      },
      schema: ReconciliationResultSchema,
      system,
      temperature: 0,
    });

    return result.object;
  } catch {
    try {
      const textResult = await generateText({
        maxRetries: 2,
        model,
        prompt: `${prompt}\n\nRespond with a valid JSON object matching {"relationType": "corroborates"|"contradicts"|"reconciled"|"uncertain", "explanation": "...", "confidence": 0.0-1.0}`,
        providerOptions: {
          google: {
            thinking: {
              budgetTokens: thinkingBudget,
            },
          },
        },
        system,
        temperature: 0,
      });

      return parseJudgeResponse(textResult.text);
    } catch (textErr: unknown) {
      const msg = textErr instanceof Error ? textErr.message : String(textErr);
      return {
        confidence: 0.2,
        explanation: `Judge call failed: ${msg}`,
        relationType: "uncertain",
      };
    }
  }
};
