import { resolve } from "node:path";
import {
  addResolveJob,
  asc,
  type BatchExtractedFact,
  type DocumentStatus,
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
import { publishDocumentProgress } from "../lib/redis";
import { endStage, stageElapsedMs, startStage } from "../lib/stage-timing";
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
  type TokenUsage,
} from "../pipeline/llm";
import { imagePathToDataUrl, renderBatchImages } from "../pipeline/renderer";

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
    pageNumbersOrHint?: number[] | number | string,
    hint?: string
  ) => Promise<Record<string, unknown>[]>;
}

function normalizeExtractedFact(
  raw: Record<string, unknown>,
  defaultPageNumber: number,
  viaVision?: boolean
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
    viaVision: typeof raw.viaVision === "boolean" ? raw.viaVision : viaVision,
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

/**
 * Pure escalation decision: which batch items are table-heavy with zero or
 * only weak (<0.7 confidence) facts. No IO — unit-testable.
 */
export function collectEscalationPages(
  batch: PageBatchItem[],
  pageMap: Map<number, PageData>,
  validFacts: BatchExtractedFact[]
): PageBatchItem[] {
  const escalations: PageBatchItem[] = [];
  for (const batchItem of batch) {
    const pageInfo = pageMap.get(batchItem.pageNumber);
    if (!pageInfo?.isTableHeavy) {
      continue;
    }
    const pageFacts = validFacts.filter(
      (f) => f.pageNumber === batchItem.pageNumber
    );
    const needsEscalation =
      pageFacts.length === 0 || pageFacts.every((f) => f.confidence < 0.7);
    if (needsEscalation) {
      escalations.push(batchItem);
    }
  }
  return escalations;
}

async function runEscalationVisionGroups(
  dataUrls: string[],
  validPageNums: number[],
  hint: string,
  options?: ProcessExtractOptions,
  onUsage?: (u: TokenUsage) => void
): Promise<{
  droppedMissingPage: number;
  facts: BatchExtractedFact[];
  visionPages: Set<number>;
}> {
  const visionPages = new Set<number>();
  const resultFacts: BatchExtractedFact[] = [];
  let droppedMissingPage = 0;
  const allowedEscalatedPages = new Set(validPageNums);
  for (let i = 0; i < dataUrls.length; i += VISION_BATCH_SIZE) {
    const urlGroup = dataUrls.slice(i, i + VISION_BATCH_SIZE);
    const numGroup = validPageNums.slice(i, i + VISION_BATCH_SIZE);
    const visionFacts = options?.visionExtractor
      ? await options.visionExtractor(urlGroup, numGroup, hint)
      : await extractVisionPage(
          urlGroup,
          numGroup,
          hint,
          onUsage ? { onUsage } : undefined
        );
    for (const vf of visionFacts) {
      const normalized = normalizeExtractedFact(
        vf,
        // Single-page escalation keeps the old attribution behavior;
        // multi-page escalation drops pageNumber-less facts rather than
        // misattributing them (grounding invariant).
        numGroup.length === 1 ? (numGroup[0] ?? -1) : -1,
        true
      );
      if (allowedEscalatedPages.has(normalized.pageNumber)) {
        resultFacts.push(normalized);
      } else {
        droppedMissingPage++;
      }
    }
    for (const pNum of numGroup) {
      visionPages.add(pNum);
    }
  }
  return { droppedMissingPage, facts: resultFacts, visionPages };
}

async function escalatePages(
  documentId: string,
  docFilePath: string | null,
  escalations: PageBatchItem[],
  pageMap: Map<number, PageData>,
  validFacts: BatchExtractedFact[],
  options?: ProcessExtractOptions,
  onUsage?: (u: TokenUsage) => void
): Promise<{ facts: BatchExtractedFact[]; visionPages: Set<number> }> {
  const visionPages = new Set<number>();
  if (escalations.length === 0 || !docFilePath) {
    return { facts: validFacts, visionPages };
  }

  try {
    // Single shared render for all escalated pages: one PDF open, not one
    // per page. Groups of VISION_BATCH_SIZE keep each vision call bounded.
    const pageNums = escalations.map((e) => e.pageNumber);
    const imageMap = await renderBatchImages(documentId, docFilePath, pageNums);
    const dataUrls: string[] = [];
    const validPageNums: number[] = [];
    const imgByPage = new Map<number, string>();
    for (const e of escalations) {
      const imgPath = imageMap.get(e.pageNumber);
      if (imgPath) {
        dataUrls.push(await imagePathToDataUrl(imgPath));
        validPageNums.push(e.pageNumber);
        imgByPage.set(e.pageNumber, imgPath);
      }
    }
    if (dataUrls.length === 0) {
      return { facts: validFacts, visionPages };
    }
    for (const [pageNum, imgPath] of imgByPage) {
      const pInfo = pageMap.get(pageNum);
      if (pInfo) {
        await db
          .update(pageChunks)
          .set({ imagePath: imgPath })
          .where(inArray(pageChunks.id, pInfo.chunkIds));
      }
    }

    const hint = escalations
      .map((e) => `--- PAGE ${e.pageNumber} ---\n${e.text}`)
      .join("\n\n");
    const {
      droppedMissingPage,
      facts: visionFacts,
      visionPages: escalatedPages,
    } = await runEscalationVisionGroups(
      dataUrls,
      validPageNums,
      hint,
      options,
      onUsage
    );
    if (droppedMissingPage > 0) {
      console.warn(
        `[Extract] Dropped ${droppedMissingPage} escalated vision facts with missing/invalid pageNumber (document ${documentId})`
      );
    }
    return {
      facts: [...validFacts, ...visionFacts],
      visionPages: escalatedPages,
    };
  } catch (escErr) {
    console.warn(
      `[Extract] Vision escalation failed for pages ${escalations.map((e) => e.pageNumber).join(",")}:`,
      escErr
    );
    return { facts: validFacts, visionPages };
  }
}

async function processVisionGroup(
  group: CompactedPageData[],
  pageMap: Map<number, PageData>,
  imageMap: Map<number, string>,
  options?: ProcessExtractOptions,
  onUsage?: (u: TokenUsage) => void
): Promise<BatchExtractedFact[]> {
  const dataUrls: string[] = [];
  const validPageNums: number[] = [];

  for (const p of group) {
    const imgPath = imageMap.get(p.pageNumber);
    if (imgPath) {
      dataUrls.push(await imagePathToDataUrl(imgPath));
      validPageNums.push(p.pageNumber);
      const pInfo = pageMap.get(p.pageNumber);
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
    : await extractVisionPage(
        dataUrls,
        validPageNums,
        combinedHint,
        onUsage ? { onUsage } : undefined
      );

  const normalizedVisionFacts: BatchExtractedFact[] = rawVisionResult.map(
    (f, idx) =>
      normalizeExtractedFact(
        f,
        validPageNums[idx % validPageNums.length] ?? 1,
        true
      )
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
  status: DocumentStatus,
  errorMessage?: string | null
): void {
  publishDocumentProgress(documentId, {
    elapsedMs: stageElapsedMs(documentId),
    errorMessage,
    progress: { current, total },
    stage: "extract",
    status,
  });
  if (status === "failed") {
    endStage(documentId);
  }
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
  options?: ProcessExtractOptions,
  onUsage?: (u: TokenUsage) => void
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
  return await extractBatch(batch, onUsage ? { onUsage } : undefined);
}

async function processTextBatches(
  documentId: string,
  docFilePath: string | null,
  textPages: CompactedPageData[],
  pageMap: Map<number, PageData>,
  onProgress: (doneDelta: number, failedDelta: number) => void,
  options?: ProcessExtractOptions,
  onUsage?: (u: TokenUsage) => void
): Promise<{
  batchCount: number;
  batchFacts: BatchExtractedFact[];
  escalatedCount: number;
  visionFactPageNumbers: Set<number>;
}> {
  const targetOutputTokens =
    Number(process.env.EXTRACT_TARGET_OUTPUT_TOKENS) || 14_000;
  // Width cap forces parallelism on dense decks whose estimates undercount
  // table output: same tokens spread over concurrent batches instead of one
  // serial mega-call (wall-clock ≈ slowest single batch).
  const maxPagesPerBatch =
    Number(process.env.EXTRACT_MAX_PAGES_PER_BATCH) || 15;
  const packedTextBatches = packPages(
    textPages.map((p) => ({
      pageNumber: p.pageNumber,
      text: p.compactedText,
      tokenEstimate: Math.ceil(p.compactedText.length / 4),
    })),
    targetOutputTokens,
    maxPagesPerBatch
  );

  const allExtractedFacts: BatchExtractedFact[] = [];
  const visionFactPageNumbers = new Set<number>();
  let escalatedCount = 0;

  const executeBatch = async (
    batch: PageBatchItem[],
    depth = 0
  ): Promise<void> => {
    try {
      const rawBatchFacts = await invokeBatchExtractor(batch, options, onUsage);
      const allowedPageNumbers = new Set(batch.map((p) => p.pageNumber));
      const { validFacts } = validateBatchResult(
        rawBatchFacts,
        allowedPageNumbers
      );
      // Escalations are collected across the whole batch and resolved with
      // shared renders + grouped vision calls — never one render per page.
      const escalations = collectEscalationPages(batch, pageMap, validFacts);
      const { facts: escalatedFacts, visionPages } = await escalatePages(
        documentId,
        docFilePath,
        escalations,
        pageMap,
        validFacts,
        options,
        onUsage
      );

      for (const vp of visionPages) {
        visionFactPageNumbers.add(vp);
      }
      escalatedCount += visionPages.size;
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

  const batchConcurrency = Number(process.env.EXTRACT_CONCURRENCY) || 6;
  await pMap(packedTextBatches, (batch) => executeBatch(batch), {
    concurrency: batchConcurrency,
  });

  return {
    batchCount: packedTextBatches.length,
    batchFacts: allExtractedFacts,
    escalatedCount,
    visionFactPageNumbers,
  };
}

async function processAllVisionPages(
  documentId: string,
  docFilePath: string | null,
  visionPages: CompactedPageData[],
  pageMap: Map<number, PageData>,
  onProgress: (doneDelta: number, failedDelta: number) => void,
  options?: ProcessExtractOptions,
  onUsage?: (u: TokenUsage) => void
): Promise<{
  groupCount: number;
  visionFacts: BatchExtractedFact[];
  visionPageNumbers: Set<number>;
}> {
  const allVisionFacts: BatchExtractedFact[] = [];
  const visionPageNumbers = new Set<number>();

  if (!docFilePath || visionPages.length === 0) {
    return { groupCount: 0, visionFacts: allVisionFacts, visionPageNumbers };
  }

  // Single shared render for all vision pages: one PDF open for the whole
  // lane instead of one per group.
  const imageMap = await renderBatchImages(
    documentId,
    docFilePath,
    visionPages.map((p) => p.pageNumber)
  );

  const groups: CompactedPageData[][] = [];
  for (let i = 0; i < visionPages.length; i += VISION_BATCH_SIZE) {
    groups.push(visionPages.slice(i, i + VISION_BATCH_SIZE));
  }

  const markGroup = async (
    group: CompactedPageData[],
    status: "extracted" | "extraction_failed"
  ): Promise<void> => {
    const failed = status === "extraction_failed";
    for (const p of group) {
      onProgress(p.chunkIds.length, failed ? p.chunkIds.length : 0);
      await db
        .update(pageChunks)
        .set({ extractionStatus: status })
        .where(inArray(pageChunks.id, p.chunkIds));
    }
  };

  await pMap(
    groups,
    async (group) => {
      try {
        const visionGroupFacts = await processVisionGroup(
          group,
          pageMap,
          imageMap,
          options,
          onUsage
        );
        for (const vf of visionGroupFacts) {
          allVisionFacts.push(vf);
          visionPageNumbers.add(vf.pageNumber);
        }
        await markGroup(group, "extracted");
      } catch (vErr) {
        console.warn("[Extract] Vision batch failed:", vErr);
        await markGroup(group, "extraction_failed");
      }
    },
    // Renders are local CPU-heavy canvas work; keep vision parallelism modest.
    { concurrency: 2 }
  );

  return {
    groupCount: groups.length,
    visionFacts: allVisionFacts,
    visionPageNumbers,
  };
}

async function cloneDuplicateFacts(
  duplicatePageMap: Map<number, number>,
  allExtractedFacts: BatchExtractedFact[],
  pageMap: Map<number, PageData>,
  onProgress: (doneDelta: number) => void
): Promise<void> {
  for (const [dupPageNum, canonicalPageNum] of duplicatePageMap.entries()) {
    const canonicalFacts = allExtractedFacts.filter(
      (f) => f.pageNumber === canonicalPageNum
    );
    for (const cf of canonicalFacts) {
      allExtractedFacts.push({ ...cf, pageNumber: dupPageNum });
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

async function persistFactSubset(
  documentId: string,
  subset: BatchExtractedFact[],
  pageMap: Map<number, PageData>,
  getOrCanonicalizeFactType: (
    description: string,
    predicate: string
  ) => Promise<string>
): Promise<number> {
  if (subset.length === 0) {
    return 0;
  }
  const validatedFacts = subset.map((fact) => {
    const pageData = pageMap.get(fact.pageNumber);
    const pageRawText = pageData?.rawText ?? "";
    const isVision = Boolean(fact.viaVision);
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

  try {
    await db
      .update(documents)
      .set({ errorMessage: null, status: "extracting" })
      .where(eq(documents.id, documentId));
    startStage(documentId);

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

    const jobStartMs = Date.now();

    // Per-job token accounting: every gateway call in the text + vision lanes
    // reports real input/output tokens here. This is the measurement base for
    // packing budgets and spend — never estimates.
    const usageTotals = { calls: 0, inputTokens: 0, outputTokens: 0 };
    const collectUsage = (u: TokenUsage): void => {
      usageTotals.calls += 1;
      usageTotals.inputTokens += u.inputTokens;
      usageTotals.outputTokens += u.outputTokens;
    };

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

    // Text-lane facts persist while the vision lane still runs: the embed +
    // canon + insert wave hides inside vision renders/vision calls instead of
    // stacking after them. The canon cache is shared, so no duplicate mints.
    const textLanePromise = processTextBatches(
      documentId,
      doc.filePath,
      textPages,
      pageMap,
      updateProgress,
      options,
      collectUsage
    ).then(async (textResult) => {
      const textPersisted = await persistFactSubset(
        documentId,
        textResult.batchFacts,
        pageMap,
        getOrCanonicalizeFactType
      );
      return { ...textResult, persistedCount: textPersisted };
    });

    const lanesStartMs = Date.now();
    const [textLane, visionLane] = await Promise.all([
      textLanePromise,
      processAllVisionPages(
        documentId,
        doc.filePath,
        visionPages,
        pageMap,
        updateProgress,
        options,
        collectUsage
      ),
    ]);
    const lanesMs = Date.now() - lanesStartMs;

    // Clone AFTER both lanes: duplicates may reference vision-lane pages.
    const allExtractedFacts = [
      ...textLane.batchFacts,
      ...visionLane.visionFacts,
    ];

    await cloneDuplicateFacts(
      duplicatePageMap,
      allExtractedFacts,
      pageMap,
      (doneDelta) => updateProgress(doneDelta, 0)
    );

    // Only vision-lane facts + clones remain unpersisted (text lane already is).
    const remainingFacts = allExtractedFacts.slice(textLane.batchFacts.length);
    const persistStartMs = Date.now();
    const remainingPersisted = await persistFactSubset(
      documentId,
      remainingFacts,
      pageMap,
      getOrCanonicalizeFactType
    );
    const persistMs = Date.now() - persistStartMs;
    const factsExtracted = textLane.persistedCount + remainingPersisted;

    await db
      .update(documents)
      .set({ errorMessage: null, status: "extracted" })
      .where(eq(documents.id, documentId));

    publishProgress(documentId, totalChunks, totalChunks, "extracted");

    console.log(
      `[Extract] documentId=${documentId} done: ${factsExtracted} facts, ` +
        `${textLane.batchCount} text batches, ${visionLane.groupCount} vision groups, ` +
        `${textLane.escalatedCount} escalations, tokens in=${usageTotals.inputTokens} out=${usageTotals.outputTokens} ` +
        `(${usageTotals.calls} calls), lanes=${lanesMs}ms persist-tail=${persistMs}ms total=${Date.now() - jobStartMs}ms`
    );

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
  } catch (fatalErr: unknown) {
    const errorMessage =
      fatalErr instanceof Error ? fatalErr.message : "Unknown extract error";

    await db
      .update(documents)
      .set({
        errorMessage,
        status: "failed",
      })
      .where(eq(documents.id, documentId));

    publishProgress(documentId, 0, 1, "failed", errorMessage);

    throw fatalErr;
  }
};
