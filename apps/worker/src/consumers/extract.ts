import { resolve } from "node:path";
import {
  addResolveJob,
  asc,
  type BatchExtractedFact,
  db,
  documents,
  type ExtractJob,
  eq,
  facts,
  factTypes,
  inArray,
  pageChunks,
  sql,
} from "@grounded/db";
import dotenv from "dotenv";
import pMap from "p-map";
import {
  applyQuoteValidation,
  assessChunk,
  buildEmbeddingInput,
  compactText,
  decideFactType,
  findRepeatedStrings,
  hashPage,
  packPages,
  splitBatch,
  validateBatchResult,
} from "../pipeline/extractor";
import {
  embedFactBatch,
  embedSingle,
  extractBatch,
  extractVisionPage,
  type PageBatchItem,
} from "../pipeline/llm";
import { imagePathToDataUrl, renderBatchImages } from "../pipeline/renderer";
import { pubRedis } from "./parse";

dotenv.config({ path: resolve(import.meta.dirname, "../../../../.env") });

export interface ExtractResult {
  chunksFailed: number;
  documentId: string;
  factsExtracted: number;
  totalPages: number;
}

export interface ProcessExtractOptions {
  batchExtractor?: (pages: PageBatchItem[]) => Promise<BatchExtractedFact[]>;
  skipBoilerplate?: boolean;
  textExtractor?: (rawText: string) => Promise<Record<string, unknown>[]>;
  visionExtractor?: (
    images: string[] | string,
    pageNumbersOrHint?: number[] | string,
    hint?: string
  ) => Promise<Record<string, unknown>[]>;
}

function normalizeExtractedFact(
  raw: Record<string, unknown>,
  defaultPageNumber: number
): BatchExtractedFact {
  return {
    confidence: typeof raw.confidence === "number" ? raw.confidence : 0,
    currency: typeof raw.currency === "string" ? raw.currency : undefined,
    entity: (raw.entity as
      | { context: string; name: string; type: string }
      | undefined) ?? {
      context: "",
      name: "Unknown",
      type: "Unknown",
    },
    factTypeDescription: String(raw.factTypeDescription ?? ""),
    pageNumber:
      typeof raw.pageNumber === "number" ? raw.pageNumber : defaultPageNumber,
    predicate: String(raw.predicate ?? ""),
    qualifiers:
      raw.qualifiers && typeof raw.qualifiers === "object"
        ? (raw.qualifiers as Record<string, unknown>)
        : {},
    rawValue: String(raw.rawValue ?? ""),
    sourceQuote: String(raw.sourceQuote ?? ""),
    timeScope: typeof raw.timeScope === "string" ? raw.timeScope : undefined,
    unit: typeof raw.unit === "string" ? raw.unit : undefined,
    value: String(raw.value ?? ""),
  };
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
      distance: sql<number>`${factTypes.embedding} <=> ${vectorStr}::vector`,
      examplePredicates: factTypes.examplePredicates,
      id: factTypes.id,
      name: factTypes.name,
    })
    .from(factTypes)
    .where(sql`${factTypes.embedding} IS NOT NULL`)
    .orderBy(sql`${factTypes.embedding} <=> ${vectorStr}::vector`)
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

export interface PageData {
  chunkIds: string[];
  firstChunkIndex: number;
  isLowText: boolean;
  isTableHeavy: boolean;
  needsVision: boolean;
  pageNumber: number;
  rawText: string;
}

export interface CompactedPageData extends PageData {
  compactedText: string;
}

const VISION_BATCH_SIZE = 3;
const BULK_INSERT_CHUNK_SIZE = 250;

function groupChunksByPage(
  chunks: (typeof pageChunks.$inferSelect)[]
): Map<number, PageData> {
  const pageMap = new Map<number, PageData>();
  for (const chunk of chunks) {
    const existing = pageMap.get(chunk.pageNumber);
    if (existing) {
      existing.rawText = `${existing.rawText}\n\n${chunk.rawText}`;
      existing.chunkIds.push(chunk.id);
      existing.isLowText = existing.isLowText && chunk.isLowText;
      existing.isTableHeavy = existing.isTableHeavy || chunk.isTableHeavy;
      existing.needsVision = existing.needsVision || chunk.needsVision;
    } else {
      pageMap.set(chunk.pageNumber, {
        chunkIds: [chunk.id],
        firstChunkIndex: chunk.chunkIndex,
        isLowText: chunk.isLowText,
        isTableHeavy: chunk.isTableHeavy,
        needsVision: chunk.needsVision,
        pageNumber: chunk.pageNumber,
        rawText: chunk.rawText,
      });
    }
  }
  return pageMap;
}

export function deduplicatePages(
  pages: PageData[],
  skipBoilerplate = process.env.SKIP_BOILERPLATE !== "0"
): {
  duplicatePageMap: Map<number, number>;
  uniquePages: CompactedPageData[];
} {
  if (!skipBoilerplate) {
    const uniquePages: CompactedPageData[] = pages.map((p) => ({
      ...p,
      compactedText: p.rawText,
    }));
    return { duplicatePageMap: new Map<number, number>(), uniquePages };
  }

  const repeatedBoilerplate = findRepeatedStrings(
    pages.map((p) => ({ text: p.rawText }))
  );
  const pagesWithCompacted: CompactedPageData[] = pages.map((p) => ({
    ...p,
    compactedText: compactText(p.rawText, repeatedBoilerplate),
  }));

  const pageHashMap = new Map<string, number>();
  const duplicatePageMap = new Map<number, number>();
  const uniquePages: CompactedPageData[] = [];

  for (const p of pagesWithCompacted) {
    if (!p.compactedText.trim()) {
      uniquePages.push(p);
      continue;
    }
    const hash = hashPage(p.compactedText);
    const canonicalPageNum = pageHashMap.get(hash);
    if (canonicalPageNum === undefined) {
      pageHashMap.set(hash, p.pageNumber);
      uniquePages.push(p);
    } else {
      duplicatePageMap.set(p.pageNumber, canonicalPageNum);
    }
  }

  return { duplicatePageMap, uniquePages };
}

interface CategorizedPages {
  deferredChunkIds: string[];
  skippedChunkIds: string[];
  textPages: CompactedPageData[];
  visionPages: CompactedPageData[];
}

function categorizePages(
  uniquePages: CompactedPageData[],
  visionEnabled = process.env.VISION_ENABLED !== "0"
): CategorizedPages {
  const textPages: CompactedPageData[] = [];
  const visionPages: CompactedPageData[] = [];
  const skippedChunkIds: string[] = [];
  const deferredChunkIds: string[] = [];

  for (const page of uniquePages) {
    const decision = assessChunk(
      {
        isLowText: page.isLowText,
        isTableHeavy: page.isTableHeavy,
        rawText: page.compactedText,
      },
      visionEnabled
    );

    if (decision === "skip") {
      skippedChunkIds.push(...page.chunkIds);
    } else if (decision === "defer-vision-disabled") {
      deferredChunkIds.push(...page.chunkIds);
    } else if (decision === "extract-vision") {
      visionPages.push(page);
    } else {
      textPages.push(page);
    }
  }

  return { deferredChunkIds, skippedChunkIds, textPages, visionPages };
}

async function escalateTablePageIfNeeded(
  documentId: string,
  docFilePath: string | null,
  batchItem: PageBatchItem,
  pageInfo: PageData | undefined,
  currentFacts: BatchExtractedFact[],
  options?: ProcessExtractOptions
): Promise<{ facts: BatchExtractedFact[]; visionEscalated: boolean }> {
  if (!(pageInfo?.isTableHeavy && docFilePath)) {
    return { facts: currentFacts, visionEscalated: false };
  }

  const pageFacts = currentFacts.filter(
    (f) => f.pageNumber === batchItem.pageNumber
  );
  const needsEscalation =
    pageFacts.length === 0 || pageFacts.every((f) => f.confidence < 0.7);
  if (!needsEscalation) {
    return { facts: currentFacts, visionEscalated: false };
  }

  try {
    const imageMap = await renderBatchImages(documentId, docFilePath, [
      batchItem.pageNumber,
    ]);
    const imgPath = imageMap.get(batchItem.pageNumber);
    if (!imgPath) {
      return { facts: currentFacts, visionEscalated: false };
    }

    const dataUrl = await imagePathToDataUrl(imgPath);
    const visionFacts = options?.visionExtractor
      ? await options.visionExtractor(
          dataUrl,
          batchItem.pageNumber.toString(),
          batchItem.text
        )
      : await extractVisionPage(
          [dataUrl],
          [batchItem.pageNumber],
          batchItem.text
        );

    await db
      .update(pageChunks)
      .set({ imagePath: imgPath })
      .where(inArray(pageChunks.id, pageInfo.chunkIds));

    const resultFacts = [...currentFacts];
    for (const vf of visionFacts) {
      resultFacts.push(normalizeExtractedFact(vf, batchItem.pageNumber));
    }
    return { facts: resultFacts, visionEscalated: true };
  } catch (escErr) {
    console.warn(
      `[Extract] Vision escalation failed for page ${batchItem.pageNumber}:`,
      escErr
    );
    return { facts: currentFacts, visionEscalated: false };
  }
}

async function processVisionGroup(
  documentId: string,
  docFilePath: string,
  group: CompactedPageData[],
  pageMap: Map<number, PageData>,
  options?: ProcessExtractOptions
): Promise<BatchExtractedFact[]> {
  const pageNums = group.map((p) => p.pageNumber);
  const imageMap = await renderBatchImages(documentId, docFilePath, pageNums);
  const dataUrls: string[] = [];
  const validPageNums: number[] = [];

  for (const pNum of pageNums) {
    const imgPath = imageMap.get(pNum);
    if (imgPath) {
      dataUrls.push(await imagePathToDataUrl(imgPath));
      validPageNums.push(pNum);
      const pInfo = pageMap.get(pNum);
      if (pInfo) {
        await db
          .update(pageChunks)
          .set({ imagePath: imgPath })
          .where(inArray(pageChunks.id, pInfo.chunkIds));
      }
    }
  }

  const combinedHint = group
    .map((p) => `--- PAGE ${p.pageNumber} ---\n${p.compactedText}`)
    .join("\n\n");

  const rawVisionResult = options?.visionExtractor
    ? await options.visionExtractor(dataUrls, validPageNums, combinedHint)
    : await extractVisionPage(dataUrls, validPageNums, combinedHint);

  const normalizedVisionFacts: BatchExtractedFact[] = rawVisionResult.map(
    (f, idx) =>
      normalizeExtractedFact(f, validPageNums[idx % validPageNums.length] ?? 1)
  );

  const { validFacts } = validateBatchResult(
    normalizedVisionFacts,
    new Set(validPageNums)
  );
  return validFacts;
}

function publishProgress(
  documentId: string,
  current: number,
  total: number,
  status: string
): void {
  pubRedis
    .publish(
      `doc:${documentId}:status`,
      JSON.stringify({
        progress: { current, total },
        status,
      })
    )
    .catch((_err) => {
      // Ignored: fire-and-forget
    });
}

async function markBatchStatus(
  batch: PageBatchItem[],
  pageMap: Map<number, PageData>,
  status: "extracted" | "extraction_failed",
  onProgress: (doneDelta: number, failedDelta: number) => void
): Promise<void> {
  const isFailed = status === "extraction_failed";
  for (const item of batch) {
    const pInfo = pageMap.get(item.pageNumber);
    if (pInfo) {
      onProgress(pInfo.chunkIds.length, isFailed ? pInfo.chunkIds.length : 0);
      await db
        .update(pageChunks)
        .set({ extractionStatus: status })
        .where(inArray(pageChunks.id, pInfo.chunkIds));
    }
  }
}

async function invokeBatchExtractor(
  batch: PageBatchItem[],
  options?: ProcessExtractOptions
): Promise<BatchExtractedFact[]> {
  if (options?.batchExtractor) {
    return await options.batchExtractor(batch);
  }
  if (options?.textExtractor) {
    const results: BatchExtractedFact[] = [];
    for (const item of batch) {
      const itemFacts = await options.textExtractor(item.text);
      for (const f of itemFacts) {
        results.push(normalizeExtractedFact(f, item.pageNumber));
      }
    }
    return results;
  }
  return await extractBatch(batch);
}

async function escalateBatchTables(
  documentId: string,
  docFilePath: string | null,
  batch: PageBatchItem[],
  pageMap: Map<number, PageData>,
  initialFacts: BatchExtractedFact[],
  options?: ProcessExtractOptions
): Promise<{ escalatedFacts: BatchExtractedFact[]; visionPages: Set<number> }> {
  let accumulatedFacts = initialFacts;
  const visionPages = new Set<number>();
  for (const batchItem of batch) {
    const pageInfo = pageMap.get(batchItem.pageNumber);
    const { facts: updatedFacts, visionEscalated } =
      await escalateTablePageIfNeeded(
        documentId,
        docFilePath,
        batchItem,
        pageInfo,
        accumulatedFacts,
        options
      );
    accumulatedFacts = updatedFacts;
    if (visionEscalated) {
      visionPages.add(batchItem.pageNumber);
    }
  }
  return { escalatedFacts: accumulatedFacts, visionPages };
}

async function processTextBatches(
  documentId: string,
  docFilePath: string | null,
  textPages: CompactedPageData[],
  pageMap: Map<number, PageData>,
  onProgress: (doneDelta: number, failedDelta: number) => void,
  options?: ProcessExtractOptions
): Promise<{
  batchFacts: BatchExtractedFact[];
  visionFactPageNumbers: Set<number>;
}> {
  const targetOutputTokens =
    Number(process.env.EXTRACT_TARGET_OUTPUT_TOKENS) || 42_000;
  const packedTextBatches = packPages(
    textPages.map((p) => ({
      pageNumber: p.pageNumber,
      text: p.compactedText,
      tokenEstimate: Math.ceil(p.compactedText.length / 4),
    })),
    targetOutputTokens
  );

  const allExtractedFacts: BatchExtractedFact[] = [];
  const visionFactPageNumbers = new Set<number>();

  const executeBatch = async (
    batch: PageBatchItem[],
    depth = 0
  ): Promise<void> => {
    try {
      const rawBatchFacts = await invokeBatchExtractor(batch, options);
      const allowedPageNumbers = new Set(batch.map((p) => p.pageNumber));
      const { validFacts } = validateBatchResult(
        rawBatchFacts,
        allowedPageNumbers
      );
      const { escalatedFacts, visionPages } = await escalateBatchTables(
        documentId,
        docFilePath,
        batch,
        pageMap,
        validFacts,
        options
      );

      for (const vp of visionPages) {
        visionFactPageNumbers.add(vp);
      }
      allExtractedFacts.push(...escalatedFacts);

      await markBatchStatus(batch, pageMap, "extracted", onProgress);
    } catch (batchErr) {
      if (depth < 1 && batch.length > 1) {
        const [b1, b2] = splitBatch(batch);
        await Promise.all([
          executeBatch(b1, depth + 1),
          b2.length > 0 ? executeBatch(b2, depth + 1) : Promise.resolve(),
        ]);
        return;
      }

      console.warn(
        `[Extract] Batch failed extraction (pages ${batch.map((p) => p.pageNumber).join(",")}):`,
        batchErr
      );
      await markBatchStatus(batch, pageMap, "extraction_failed", onProgress);
    }
  };

  await pMap(packedTextBatches, (batch) => executeBatch(batch), {
    concurrency: 6,
  });

  return { batchFacts: allExtractedFacts, visionFactPageNumbers };
}

async function processAllVisionPages(
  documentId: string,
  docFilePath: string | null,
  visionPages: CompactedPageData[],
  pageMap: Map<number, PageData>,
  onProgress: (doneDelta: number, failedDelta: number) => void,
  options?: ProcessExtractOptions
): Promise<{
  visionFacts: BatchExtractedFact[];
  visionPageNumbers: Set<number>;
}> {
  const allVisionFacts: BatchExtractedFact[] = [];
  const visionPageNumbers = new Set<number>();

  if (!docFilePath || visionPages.length === 0) {
    return { visionFacts: allVisionFacts, visionPageNumbers };
  }

  for (let i = 0; i < visionPages.length; i += VISION_BATCH_SIZE) {
    const group = visionPages.slice(i, i + VISION_BATCH_SIZE);
    try {
      const visionGroupFacts = await processVisionGroup(
        documentId,
        docFilePath,
        group,
        pageMap,
        options
      );
      for (const vf of visionGroupFacts) {
        allVisionFacts.push(vf);
        visionPageNumbers.add(vf.pageNumber);
      }
      for (const p of group) {
        onProgress(p.chunkIds.length, 0);
        await db
          .update(pageChunks)
          .set({ extractionStatus: "extracted" })
          .where(inArray(pageChunks.id, p.chunkIds));
      }
    } catch (vErr) {
      console.warn("[Extract] Vision batch failed:", vErr);
      for (const p of group) {
        onProgress(p.chunkIds.length, p.chunkIds.length);
        await db
          .update(pageChunks)
          .set({ extractionStatus: "extraction_failed" })
          .where(inArray(pageChunks.id, p.chunkIds));
      }
    }
  }

  return { visionFacts: allVisionFacts, visionPageNumbers };
}

async function cloneDuplicateFacts(
  duplicatePageMap: Map<number, number>,
  allExtractedFacts: BatchExtractedFact[],
  visionFactPageNumbers: Set<number>,
  pageMap: Map<number, PageData>,
  onProgress: (doneDelta: number) => void
): Promise<void> {
  for (const [dupPageNum, canonicalPageNum] of duplicatePageMap.entries()) {
    const canonicalFacts = allExtractedFacts.filter(
      (f) => f.pageNumber === canonicalPageNum
    );
    for (const cf of canonicalFacts) {
      allExtractedFacts.push({ ...cf, pageNumber: dupPageNum });
      if (visionFactPageNumbers.has(canonicalPageNum)) {
        visionFactPageNumbers.add(dupPageNum);
      }
    }
    const dupPageData = pageMap.get(dupPageNum);
    if (dupPageData) {
      onProgress(dupPageData.chunkIds.length);
      await db
        .update(pageChunks)
        .set({ extractionStatus: "extracted" })
        .where(inArray(pageChunks.id, dupPageData.chunkIds));
    }
  }
}

async function persistExtractedFacts(
  documentId: string,
  allExtractedFacts: BatchExtractedFact[],
  visionFactPageNumbers: Set<number>,
  pageMap: Map<number, PageData>,
  getOrCanonicalizeFactType: (
    description: string,
    predicate: string
  ) => Promise<string>
): Promise<number> {
  const validatedFacts = allExtractedFacts.map((fact) => {
    const pageData = pageMap.get(fact.pageNumber);
    const pageRawText = pageData?.rawText ?? "";
    const isVision = visionFactPageNumbers.has(fact.pageNumber);
    return applyQuoteValidation(fact, pageRawText, isVision);
  });

  const uniqueDescriptions = Array.from(
    new Set(
      validatedFacts.map(({ fact }) => `category: ${fact.factTypeDescription}`)
    )
  );
  if (uniqueDescriptions.length > 0) {
    await embedFactBatch(uniqueDescriptions);
  }

  const embeddingInputs = validatedFacts.map(({ fact }) =>
    buildEmbeddingInput(fact)
  );

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
    const pageData = pageMap.get(fact.pageNumber);
    const chunkIndex = pageData?.firstChunkIndex ?? 0;

    const qualifiersRecord: Record<string, unknown> = Array.isArray(
      fact.qualifiers
    )
      ? Object.fromEntries(fact.qualifiers.map((q) => [q.key, q.value]))
      : { ...((fact.qualifiers as Record<string, unknown> | null) ?? {}) };

    qualifiersRecord._entity = {
      context: fact.entity.context,
      name: fact.entity.name,
      type: fact.entity.type,
    };

    return {
      confidence: fact.confidence,
      currency: fact.currency ?? null,
      documentId,
      embedding,
      entityId: null,
      extractedAt: new Date(),
      factTypeId,
      predicate: fact.predicate,
      qualifiers: qualifiersRecord,
      rawValue: fact.rawValue,
      sourceChunkIndex: chunkIndex,
      sourcePage: fact.pageNumber,
      sourceQuote: fact.sourceQuote,
      sourceQuoteValid,
      timeScope: fact.timeScope ?? null,
      unit: fact.unit ?? null,
      value: fact.value,
    };
  });

  if (rowsToInsert.length > 0) {
    for (let i = 0; i < rowsToInsert.length; i += BULK_INSERT_CHUNK_SIZE) {
      await db
        .insert(facts)
        .values(rowsToInsert.slice(i, i + BULK_INSERT_CHUNK_SIZE));
    }
  }

  return rowsToInsert.length;
}

export const processExtractJob = async (
  jobData: ExtractJob,
  options?: ProcessExtractOptions
): Promise<ExtractResult> => {
  const { documentId } = jobData;

  const [doc] = await db
    .select()
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);

  if (!doc) {
    throw new Error(`Document ${documentId} not found in database.`);
  }

  await db
    .update(documents)
    .set({ errorMessage: null, status: "extracting" })
    .where(eq(documents.id, documentId));

  if (pubRedis.status === "wait") {
    await pubRedis.connect().catch((_err) => {
      // Ignored: best-effort
    });
  }

  await db.delete(facts).where(eq(facts.documentId, documentId));

  const chunks = await db
    .select()
    .from(pageChunks)
    .where(eq(pageChunks.documentId, documentId))
    .orderBy(asc(pageChunks.pageNumber), asc(pageChunks.chunkIndex));

  const totalChunks = chunks.length;
  if (totalChunks === 0) {
    await db
      .update(documents)
      .set({ errorMessage: null, status: "extracted" })
      .where(eq(documents.id, documentId));
    return {
      chunksFailed: 0,
      documentId,
      factsExtracted: 0,
      totalPages: doc.pageCount ?? 0,
    };
  }

  publishProgress(documentId, 0, totalChunks, "extracting");

  const pageMap = groupChunksByPage(chunks);
  const pages = Array.from(pageMap.values()).sort(
    (a, b) => a.pageNumber - b.pageNumber
  );
  const { duplicatePageMap, uniquePages } = deduplicatePages(
    pages,
    options?.skipBoilerplate
  );
  const { deferredChunkIds, skippedChunkIds, textPages, visionPages } =
    categorizePages(uniquePages);

  let doneChunks = 0;
  let chunksFailed = 0;
  const updateProgress = (doneDelta: number, failedDelta = 0) => {
    doneChunks = Math.min(totalChunks, doneChunks + doneDelta);
    chunksFailed += failedDelta;
    publishProgress(documentId, doneChunks, totalChunks, "extracting");
  };

  if (skippedChunkIds.length > 0) {
    updateProgress(skippedChunkIds.length, 0);
    await db
      .update(pageChunks)
      .set({ extractionStatus: "extracted" })
      .where(inArray(pageChunks.id, skippedChunkIds));
  }

  if (deferredChunkIds.length > 0) {
    updateProgress(deferredChunkIds.length, 0);
    await db
      .update(pageChunks)
      .set({ extractionStatus: "extraction_deferred" })
      .where(inArray(pageChunks.id, deferredChunkIds));
  }

  const [
    { batchFacts, visionFactPageNumbers: textVisionPages },
    { visionFacts, visionPageNumbers: directVisionPages },
  ] = await Promise.all([
    processTextBatches(
      documentId,
      doc.filePath,
      textPages,
      pageMap,
      updateProgress,
      options
    ),
    processAllVisionPages(
      documentId,
      doc.filePath,
      visionPages,
      pageMap,
      updateProgress,
      options
    ),
  ]);

  const allExtractedFacts = [...batchFacts, ...visionFacts];
  const visionFactPageNumbers = new Set([
    ...textVisionPages,
    ...directVisionPages,
  ]);

  await cloneDuplicateFacts(
    duplicatePageMap,
    allExtractedFacts,
    visionFactPageNumbers,
    pageMap,
    (doneDelta) => updateProgress(doneDelta, 0)
  );

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

  const factsExtracted = await persistExtractedFacts(
    documentId,
    allExtractedFacts,
    visionFactPageNumbers,
    pageMap,
    getOrCanonicalizeFactType
  );

  await db
    .update(documents)
    .set({ errorMessage: null, status: "extracted" })
    .where(eq(documents.id, documentId));

  publishProgress(documentId, totalChunks, totalChunks, "extracted");

  try {
    await addResolveJob({ documentId });
  } catch {
    // Ignored: best-effort queueing
  }

  return {
    chunksFailed,
    documentId,
    factsExtracted,
    totalPages: doc.pageCount ?? pages.length,
  };
};
