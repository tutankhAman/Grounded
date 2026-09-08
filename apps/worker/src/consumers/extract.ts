import { resolve } from "node:path";
import {
  asc,
  db,
  documents,
  type ExtractJob,
  eq,
  facts,
  factTypes,
  pageChunks,
  sql,
} from "@grounded/db";
import dotenv from "dotenv";
import pMap from "p-map";
import {
  applyQuoteValidation,
  assessChunk,
  buildEmbeddingInput,
  decideFactType,
} from "../pipeline/extractor";
import {
  ExtractionFailedError,
  embedFactBatch,
  embedSingle,
  extractTextChunk,
  extractVisionPage,
} from "../pipeline/llm";
import { imagePathToDataUrl, renderPageImage } from "../pipeline/renderer";
import { pubRedis } from "./parse";

dotenv.config({ path: resolve(import.meta.dirname, "../../../../.env") });

export interface ExtractResult {
  chunksFailed: number;
  documentId: string;
  factsExtracted: number;
  totalPages: number;
}

export interface ProcessExtractOptions {
  textExtractor?: (rawText: string) => Promise<ExtractedFact[]>;
  visionExtractor?: (
    imageDataUrl: string,
    rawTextHint?: string
  ) => Promise<ExtractedFact[]>;
}

export const canonicalizeFactType = async (
  factTypeDescription: string,
  predicate: string,
  threshold = Number(process.env.FACT_TYPE_SIMILARITY_THRESHOLD ?? 0.85)
): Promise<string> => {
  // Fast path: exact description match in DB skips embedding entirely
  const [exactMatch] = await db
    .select({
      examplePredicates: factTypes.examplePredicates,
      id: factTypes.id,
    })
    .from(factTypes)
    .where(eq(factTypes.description, factTypeDescription))
    .limit(1);

  if (exactMatch) {
    const existingExamples = Array.isArray(exactMatch.examplePredicates)
      ? (exactMatch.examplePredicates as string[])
      : [];
    if (!existingExamples.includes(predicate)) {
      await db
        .update(factTypes)
        .set({
          examplePredicates: [...existingExamples, predicate],
        })
        .where(eq(factTypes.id, exactMatch.id));
    }
    return exactMatch.id;
  }

  const descEmbedding = await embedSingle(`category: ${factTypeDescription}`);
  const vectorStr = `[${descEmbedding.join(",")}]`;

  // Query nearest fact_type by cosine distance
  const candidates = await db
    .select({
      distance: sql<number>`${factTypes.embedding} <=> ${sql.raw(`'${vectorStr}'::vector`)}`,
      examplePredicates: factTypes.examplePredicates,
      id: factTypes.id,
      name: factTypes.name,
    })
    .from(factTypes)
    .where(sql`${factTypes.embedding} IS NOT NULL`)
    .orderBy(
      sql`${factTypes.embedding} <=> ${sql.raw(`'${vectorStr}'::vector`)}`
    )
    .limit(1);

  const [best] = candidates;
  const similarity = best ? 1 - Number(best.distance) : null;
  const decision = decideFactType(similarity, threshold);

  if (decision === "link" && best) {
    const existingExamples = Array.isArray(best.examplePredicates)
      ? (best.examplePredicates as string[])
      : [];
    if (!existingExamples.includes(predicate)) {
      await db
        .update(factTypes)
        .set({
          examplePredicates: [...existingExamples, predicate],
        })
        .where(eq(factTypes.id, best.id));
    }
    return best.id;
  }

  // Mint new fact type
  const [created] = await db
    .insert(factTypes)
    .values({
      createdAt: new Date(),
      description: factTypeDescription,
      embedding: descEmbedding,
      examplePredicates: [predicate],
      name: predicate,
    })
    .returning({ id: factTypes.id });

  return created.id;
};

export const processExtractJob = async (
  jobData: ExtractJob,
  options?: ProcessExtractOptions
): Promise<ExtractResult> => {
  const { documentId } = jobData;
  const extractText = options?.textExtractor ?? extractTextChunk;
  const extractVision = options?.visionExtractor ?? extractVisionPage;

  // 1. Fetch document
  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!doc) {
    throw new Error(`Document ${documentId} not found in database.`);
  }

  // 2. Transition document status to 'extracting'
  await db
    .update(documents)
    .set({
      errorMessage: null,
      status: "extracting",
    })
    .where(eq(documents.id, documentId));

  // Connect pub redis if needed
  if (pubRedis.status === "wait") {
    await pubRedis.connect().catch((_err) => {
      // Ignored: best-effort
    });
  }

  // 3. Idempotency: remove previously extracted facts for this document
  await db.delete(facts).where(eq(facts.documentId, documentId));

  // 4. Load all chunks ordered by pageNumber, chunkIndex
  const chunks = await db
    .select()
    .from(pageChunks)
    .where(eq(pageChunks.documentId, documentId))
    .orderBy(asc(pageChunks.pageNumber), asc(pageChunks.chunkIndex));

  const totalChunks = chunks.length;

  pubRedis
    .publish(
      `doc:${documentId}:status`,
      JSON.stringify({
        progress: {
          current: 0,
          total: totalChunks,
        },
        status: "extracting",
      })
    )
    .catch((_err) => {
      // Ignored: fire-and-forget
    });

  let doneChunks = 0;
  let factsExtracted = 0;
  let chunksFailed = 0;

  // In-flight canonicalization cache per document to prevent duplicate inserts across parallel chunks
  const canonicalizeCache = new Map<string, Promise<string>>();

  const getOrCanonicalizeFactType = (
    description: string,
    predicate: string
  ): Promise<string> => {
    const key = description.trim().toLowerCase();
    const existing = canonicalizeCache.get(key);
    if (existing) {
      return existing;
    }
    const promise = canonicalizeFactType(description, predicate);
    canonicalizeCache.set(key, promise);
    return promise;
  };

  const extractChunkFacts = async (
    chunk: (typeof chunks)[number],
    decision: "extract-vision" | "extract-text"
  ): Promise<{ facts: ExtractedFact[]; visionOnly: boolean }> => {
    if (decision === "extract-vision") {
      const imagePath = await renderPageImage(
        documentId,
        chunk.pageNumber,
        doc.filePath
      );
      await db
        .update(pageChunks)
        .set({ imagePath })
        .where(eq(pageChunks.id, chunk.id));

      const dataUrl = await imagePathToDataUrl(imagePath);
      const rawFacts = await extractVision(dataUrl, chunk.rawText);
      return { facts: rawFacts, visionOnly: true };
    }

    const rawFacts = await extractText(chunk.rawText);
    return { facts: rawFacts, visionOnly: false };
  };

  const persistChunkFacts = async (
    chunk: (typeof chunks)[number],
    rawFacts: ExtractedFact[],
    visionOnly: boolean
  ): Promise<number> => {
    const validatedFacts = rawFacts.map((fact) =>
      applyQuoteValidation(fact, chunk.rawText, visionOnly)
    );

    const embeddingInputs = validatedFacts.map(({ fact }) =>
      buildEmbeddingInput(fact)
    );

    // Pre-warm unique fact type descriptions into embedding cache in 1 single batch call
    const uniqueDescriptions = Array.from(
      new Set(
        validatedFacts.map(
          ({ fact }) => `category: ${fact.factTypeDescription}`
        )
      )
    );
    await embedFactBatch(uniqueDescriptions);

    // Concurrently compute embeddings and resolve fact types
    const [embeddings, factTypeIds] = await Promise.all([
      embedFactBatch(embeddingInputs),
      Promise.all(
        validatedFacts.map(({ fact }) =>
          getOrCanonicalizeFactType(fact.factTypeDescription, fact.predicate)
        )
      ),
    ]);

    const rowsToInsert = validatedFacts.map(({ fact, sourceQuoteValid }, i) => {
      const embedding = embeddings[i] ?? null;
      const factTypeId = factTypeIds[i];

      const qualifiersRecord: Record<string, unknown> = Array.isArray(
        fact.qualifiers
      )
        ? Object.fromEntries(fact.qualifiers.map((q) => [q.key, q.value]))
        : ((fact.qualifiers as Record<string, unknown> | null) ?? {});

      return {
        confidence: fact.confidence,
        currency: fact.currency ?? null,
        documentId,
        embedding,
        entityId: null, // Resolved in Phase 3
        extractedAt: new Date(),
        factTypeId,
        predicate: fact.predicate,
        qualifiers: qualifiersRecord,
        rawValue: fact.rawValue,
        sourceChunkIndex: chunk.chunkIndex,
        sourcePage: chunk.pageNumber,
        sourceQuote: fact.sourceQuote,
        sourceQuoteValid,
        timeScope: fact.timeScope ?? null,
        unit: fact.unit ?? null,
        value: fact.value,
      };
    });

    await db.insert(facts).values(rowsToInsert);

    return validatedFacts.length;
  };

  const processChunk = async (
    chunk: (typeof chunks)[number]
  ): Promise<void> => {
    try {
      const decision = assessChunk({
        isLowText: chunk.isLowText,
        isTableHeavy: chunk.isTableHeavy,
        needsVision: chunk.needsVision,
        rawText: chunk.rawText,
        runs: Array.isArray(chunk.positionData) ? chunk.positionData : [],
      });

      if (decision === "skip-empty") {
        await db
          .update(pageChunks)
          .set({ extractionStatus: "extracted" })
          .where(eq(pageChunks.id, chunk.id));
        return;
      }

      if (decision === "defer-vision-disabled") {
        await db
          .update(pageChunks)
          .set({ extractionStatus: "extraction_deferred" })
          .where(eq(pageChunks.id, chunk.id));
        return;
      }

      const { facts: rawFacts, visionOnly } = await extractChunkFacts(
        chunk,
        decision
      );

      if (rawFacts.length > 0) {
        const persisted = await persistChunkFacts(chunk, rawFacts, visionOnly);
        factsExtracted += persisted;
      }

      await db
        .update(pageChunks)
        .set({ extractionStatus: "extracted" })
        .where(eq(pageChunks.id, chunk.id));
    } catch (err: unknown) {
      chunksFailed++;
      const message = err instanceof Error ? err.message : String(err);
      const rawOutput =
        err instanceof ExtractionFailedError ? err.rawOutput : undefined;

      console.warn(
        `[Extract] Chunk ${chunk.id} (page ${chunk.pageNumber}, chunk ${chunk.chunkIndex}) failed: ${message}${rawOutput ? `\nRaw output: ${rawOutput}` : ""}`
      );

      await db
        .update(pageChunks)
        .set({ extractionStatus: "extraction_failed" })
        .where(eq(pageChunks.id, chunk.id));
    } finally {
      doneChunks++;
      pubRedis
        .publish(
          `doc:${documentId}:status`,
          JSON.stringify({
            progress: {
              current: doneChunks,
              total: totalChunks,
            },
            status: "extracting",
          })
        )
        .catch((_err) => {
          // Ignored: fire-and-forget
        });
    }
  };

  try {
    // Process chunks with bounded concurrency 5
    await pMap(chunks, processChunk, { concurrency: 5 });

    // Mark document extracted
    await db
      .update(documents)
      .set({
        errorMessage: null,
        status: "extracted",
      })
      .where(eq(documents.id, documentId));

    pubRedis
      .publish(
        `doc:${documentId}:status`,
        JSON.stringify({
          progress: {
            current: totalChunks,
            total: totalChunks,
          },
          status: "extracted",
        })
      )
      .catch((_err) => {
        // Ignored: fire-and-forget
      });

    return {
      chunksFailed,
      documentId,
      factsExtracted,
      totalPages: doc.pageCount ?? totalChunks,
    };
  } catch (fatalErr: unknown) {
    const errorMessage =
      fatalErr instanceof Error ? fatalErr.message : "Fatal extraction failure";

    await db
      .update(documents)
      .set({
        errorMessage,
        status: "failed",
      })
      .where(eq(documents.id, documentId));

    pubRedis
      .publish(
        `doc:${documentId}:status`,
        JSON.stringify({
          error: errorMessage,
          status: "failed",
        })
      )
      .catch((_err) => {
        // Ignored: fire-and-forget
      });

    throw fatalErr;
  }
};
