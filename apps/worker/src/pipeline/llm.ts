import {
  createGoogleGenerativeAI,
  type GoogleEmbeddingModelOptions,
} from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import {
  EMBEDDING_DIM,
  type ExtractedFact,
  ExtractionResultSchema,
} from "@grounded/db";
import { embedMany, generateObject, generateText } from "ai";
import { EXTRACTION_SYSTEM_PROMPT, parseFallbackOutput } from "./extractor";

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

export const getSambaNovaProvider = () => {
  const apiKey = process.env.SAMBANOVA_API_KEY;
  if (!apiKey) {
    throw new Error("SAMBANOVA_API_KEY is required for text fact extraction.");
  }
  return createOpenAI({
    apiKey,
    baseURL: process.env.SAMBANOVA_BASE_URL || "https://api.sambanova.ai/v1",
  });
};

export const getGoogleProvider = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error(
      "GEMINI_API_KEY is required for embeddings and vision fact extraction."
    );
  }
  return createGoogleGenerativeAI({ apiKey });
};

export interface ExtractTextOptions {
  forceFailure?: boolean;
  systemPrompt?: string;
}

export const extractTextChunk = async (
  rawText: string,
  options?: ExtractTextOptions
): Promise<ExtractedFact[]> => {
  if (options?.forceFailure) {
    throw new ExtractionFailedError(
      "Forced extraction failure requested for testing",
      { rawOutput: "ERROR" }
    );
  }

  const sambanova = getSambaNovaProvider();
  const modelName = process.env.SAMBANOVA_MODEL ?? "gpt-oss-120b";
  const model = sambanova(modelName);
  const systemPrompt = options?.systemPrompt ?? EXTRACTION_SYSTEM_PROMPT;

  try {
    const result = await generateObject({
      maxRetries: 2,
      mode: "json",
      model,
      prompt: `Extract all facts from this document chunk:\n\n${rawText}`,
      schema: ExtractionResultSchema,
      system: `${systemPrompt}\nEnsure EVERY fact object includes: entity ({name, type, context}), predicate, value, rawValue, confidence, sourceQuote, factTypeDescription.`,
      temperature: 0,
    });
    return result.object.facts;
  } catch (schemaErr: unknown) {
    try {
      const rawResult = await generateText({
        maxRetries: 2,
        model,
        prompt: `Extract all facts from this document chunk:\n\n${rawText}`,
        system: `${systemPrompt}\nReturn ONLY valid JSON matching {"facts": [...]} with no other markdown or explanation.`,
        temperature: 0,
      });

      const fallback = parseFallbackOutput(rawResult.text);
      if (fallback.ok) {
        return fallback.facts;
      }
      throw new ExtractionFailedError(
        `Fallback JSON parse failed: ${fallback.error}`,
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
      throw new ExtractionFailedError(
        `Text chunk extraction failed: ${message}`,
        {
          cause: fallbackErr,
          rawOutput: schemaErr instanceof Error ? schemaErr.message : undefined,
        }
      );
    }
  }
};

export const extractVisionPage = async (
  imageDataUrl: string,
  rawTextHint?: string
): Promise<ExtractedFact[]> => {
  const google = getGoogleProvider();
  const visionModelName = process.env.VISION_MODEL ?? "gemini-3.5-flash-lite";
  const model = google(visionModelName);

  const promptText = rawTextHint
    ? `Extract all facts visible in this table or slide.\n\nContext text from page:\n${rawTextHint}`
    : "Extract all facts visible in this table or slide.";

  try {
    const result = await generateObject({
      maxRetries: 2,
      messages: [
        {
          content: [
            {
              data: imageDataUrl,
              mediaType: "image/png",
              type: "file",
            },
            {
              text: promptText,
              type: "text",
            },
          ],
          role: "user",
        },
      ],
      model,
      schema: ExtractionResultSchema,
      system: EXTRACTION_SYSTEM_PROMPT,
      temperature: 0,
    });
    return result.object.facts;
  } catch (schemaErr: unknown) {
    try {
      const rawResult = await generateText({
        maxRetries: 2,
        messages: [
          {
            content: [
              {
                data: imageDataUrl,
                mediaType: "image/png",
                type: "file",
              },
              {
                text: `${promptText}\n\nReturn ONLY valid JSON matching {"facts": [...]} with no other text.`,
                type: "text",
              },
            ],
            role: "user",
          },
        ],
        model,
        system: EXTRACTION_SYSTEM_PROMPT,
        temperature: 0,
      });

      const fallback = parseFallbackOutput(rawResult.text);
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
        fallbackErr instanceof Error
          ? fallbackErr.message
          : String(fallbackErr);
      throw new ExtractionFailedError(
        `Vision page extraction failed: ${message}`,
        {
          cause: fallbackErr,
          rawOutput: schemaErr instanceof Error ? schemaErr.message : undefined,
        }
      );
    }
  }
};

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
  missingValues: string[]
): Promise<number[][]> => {
  const google = getGoogleProvider();
  const modelName = process.env.EMBEDDING_MODEL ?? "gemini-embedding-2";
  const dim = Number(process.env.EMBEDDING_DIM ?? EMBEDDING_DIM);
  const BATCH_SIZE = 100;
  const fetched: number[][] = [];

  for (let i = 0; i < missingValues.length; i += BATCH_SIZE) {
    const batch = missingValues.slice(i, i + BATCH_SIZE);
    const embeddings = await embedWithRetry(
      google.embedding(modelName),
      {
        google: {
          outputDimensionality: dim,
        } satisfies GoogleEmbeddingModelOptions,
      },
      batch
    );

    for (let j = 0; j < batch.length; j++) {
      const val = batch[j];
      const emb = embeddings[j];
      if (emb) {
        setInEmbeddingCache(val, emb);
        fetched.push(emb);
      }
    }
  }

  return fetched;
};

export const embedFactBatch = async (inputs: string[]): Promise<number[][]> => {
  if (inputs.length === 0) {
    return [];
  }

  const results: (number[] | undefined)[] = new Array(inputs.length);
  const missingIndices: number[] = [];
  const missingValues: string[] = [];

  for (let i = 0; i < inputs.length; i++) {
    const text = inputs[i];
    const cached = embeddingCache.get(text);
    if (cached) {
      results[i] = cached;
    } else {
      missingIndices.push(i);
      missingValues.push(text);
    }
  }

  if (missingValues.length > 0) {
    const fetched = await fetchAndCacheMissing(missingValues);
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
