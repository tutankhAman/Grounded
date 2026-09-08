import { resolve } from "node:path";
import {
  and,
  type DocumentStatus,
  db,
  documents,
  entities,
  eq,
  facts,
  getReconcileThresholds,
  inArray,
  ne,
  or,
  type ReconcileJob,
  type ReconciliationResult,
  relationships,
  sql,
} from "@grounded/db";
import dotenv from "dotenv";
import pMap from "p-map";
import { publishDocumentProgress } from "../lib/redis";
import { endStage, stageElapsedMs, startStage } from "../lib/stage-timing";
import { buildMatchEmbeddingInput, judgeFactPair } from "../pipeline/llm";
import { ruleReconcile } from "../pipeline/matcher";
import {
  canonicalizePair,
  type FactDetail,
  isCandidatePredicateMatch,
} from "../pipeline/reconciler";

dotenv.config({ path: resolve(import.meta.dirname, "../../../../.env") });

export { pubRedis } from "../lib/redis";

const BULK_INSERT_CHUNK_SIZE = 250;
const EMBED_QUERY_TASK_TYPE = "RETRIEVAL_QUERY";

export interface ReconcileResult {
  documentId: string;
  factsMatched: number;
  judgeCalls: number;
  pairsEvaluated: number;
  relationshipsCreated: number;
  ruleResolved: number;
  skippedNoEmbedding: number;
  skippedNoEntity: number;
  success: boolean;
}

export interface ExistingFactRow {
  currency: string | null;
  documentId: string;
  embedding: number[] | null;
  entityId: string | null;
  entityName: string | null;
  factTypeId: string | null;
  id: string;
  predicate: string;
  qualifiers: unknown;
  rawValue: string;
  sourcePage: number;
  sourceQuote: string;
  timeScope: string | null;
  unit: string | null;
  value: string;
}

export interface CandidateFactRow extends Omit<ExistingFactRow, "embedding"> {
  candidateFilename: string | null;
  distance: number;
}

export interface ProcessReconcileOptions {
  embedFn?: (
    texts: string[],
    options?: { taskType?: string }
  ) => Promise<number[][]>;
  judgeFn?: (
    pair: { factA: FactDetail; factB: FactDetail },
    options?: {
      docA?: { filename: string } | null;
      docB?: { filename: string } | null;
    }
  ) => Promise<{
    confidence: number;
    explanation: string;
    relationType: string;
  }>;
  matchCandidates?: number;
  matchDistance?: number;
  reconcileConcurrency?: number;
}

const publishProgress = (
  documentId: string,
  current: number,
  total: number,
  status: DocumentStatus
): void => {
  publishDocumentProgress(documentId, {
    elapsedMs: stageElapsedMs(documentId),
    progress: { current, total },
    stage: "reconcile",
    status,
  });
  if (status === "done" || status === "failed") {
    endStage(documentId);
  }
};

const toFactDetail = (row: ExistingFactRow | CandidateFactRow): FactDetail => ({
  currency: row.currency,
  id: row.id,
  predicate: row.predicate,
  qualifiers: row.qualifiers,
  rawValue: row.rawValue,
  sourcePage: row.sourcePage,
  sourceQuote: row.sourceQuote,
  timeScope: row.timeScope,
  unit: row.unit,
  value: row.value,
});

const loadDocumentFacts = async (
  documentId: string
): Promise<ExistingFactRow[]> =>
  db
    .select({
      currency: facts.currency,
      documentId: facts.documentId,
      embedding: facts.embedding,
      entityId: facts.entityId,
      entityName: entities.canonicalName,
      factTypeId: facts.factTypeId,
      id: facts.id,
      predicate: facts.predicate,
      qualifiers: facts.qualifiers,
      rawValue: facts.rawValue,
      sourcePage: facts.sourcePage,
      sourceQuote: facts.sourceQuote,
      timeScope: facts.timeScope,
      unit: facts.unit,
      value: facts.value,
    })
    .from(facts)
    .leftJoin(entities, eq(entities.id, facts.entityId))
    .where(eq(facts.documentId, documentId));

interface CandidateQueryRow {
  candidateFilename: string | null;
  currency: string | null;
  documentId: string;
  entityId: string | null;
  factTypeId: string | null;
  id: string;
  predicate: string;
  qualifiers: unknown;
  rawValue: string;
  sourcePage: number;
  sourceQuote: string;
  timeScope: string | null;
  unit: string | null;
  value: string;
  vectorDistance: number | null;
}

export const findCandidateFacts = async (
  entityId: string,
  documentId: string,
  queryEmbedding: number[],
  maxDistance: number,
  limit: number,
  sourceFactId?: string
): Promise<CandidateFactRow[]> => {
  const vectorStr = `[${queryEmbedding.join(",")}]`;
  const rows: CandidateQueryRow[] = await db
    .select({
      candidateFilename: documents.filename,
      currency: facts.currency,
      documentId: facts.documentId,
      entityId: facts.entityId,
      factTypeId: facts.factTypeId,
      id: facts.id,
      predicate: facts.predicate,
      qualifiers: facts.qualifiers,
      rawValue: facts.rawValue,
      sourcePage: facts.sourcePage,
      sourceQuote: facts.sourceQuote,
      timeScope: facts.timeScope,
      unit: facts.unit,
      value: facts.value,
      vectorDistance: sql<
        number | null
      >`${facts.embedding} <=> ${vectorStr}::vector`,
    })
    .from(facts)
    .innerJoin(documents, eq(documents.id, facts.documentId))
    .where(
      and(
        eq(facts.entityId, entityId),
        ne(facts.documentId, documentId),
        sourceFactId ? ne(facts.id, sourceFactId) : undefined,
        sql`${facts.embedding} IS NOT NULL`,
        sql`${facts.embedding} <=> ${vectorStr}::vector < ${maxDistance}`
      )
    )
    .orderBy(sql`${facts.embedding} <=> ${vectorStr}::vector`)
    .limit(limit);

  return rows.map((row) => ({
    candidateFilename: row.candidateFilename,
    currency: row.currency,
    distance: Number(row.vectorDistance ?? 2),
    documentId: row.documentId,
    entityId: row.entityId,
    entityName: null,
    factTypeId: row.factTypeId,
    id: row.id,
    predicate: row.predicate,
    qualifiers: row.qualifiers,
    rawValue: row.rawValue,
    sourcePage: row.sourcePage,
    sourceQuote: row.sourceQuote,
    timeScope: row.timeScope,
    unit: row.unit,
    value: row.value,
  }));
};

const loadExistingPairKeys = async (
  documentId: string
): Promise<Set<string>> => {
  const docFactIds = (
    await db
      .select({ id: facts.id })
      .from(facts)
      .where(eq(facts.documentId, documentId))
  ).map((r) => r.id);

  const keys = new Set<string>();
  if (docFactIds.length === 0) {
    return keys;
  }

  const rows = await db
    .select({
      factAId: relationships.factAId,
      factBId: relationships.factBId,
    })
    .from(relationships)
    .where(
      or(
        inArray(relationships.factAId, docFactIds),
        inArray(relationships.factBId, docFactIds)
      )
    );

  for (const row of rows) {
    keys.add(`${row.factAId}|${row.factBId}`);
  }
  return keys;
};

const insertRelationshipRows = async (
  rows: {
    confidence: number;
    explanation: string;
    factAId: string;
    factBId: string;
    method: string;
    relationType: string;
  }[]
): Promise<number> => {
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BULK_INSERT_CHUNK_SIZE) {
    const chunk = rows.slice(i, i + BULK_INSERT_CHUNK_SIZE);
    // biome-ignore lint/performance/noAwaitInLoops: chunked sequential inserts bound memory and avoid oversized transactions
    const result = await db
      .insert(relationships)
      .values(
        chunk.map((row) => ({
          confidence: row.confidence,
          explanation: row.explanation,
          factAId: row.factAId,
          factBId: row.factBId,
          method: row.method,
          relationType: row.relationType,
        }))
      )
      .onConflictDoNothing({
        target: [relationships.factAId, relationships.factBId],
      })
      .returning({ id: relationships.id });
    inserted += result.length;
  }
  return inserted;
};

interface PendingRelationRow {
  confidence: number;
  explanation: string;
  factAId: string;
  factBId: string;
  method: string;
  relationType: string;
}

export const evaluateCandidatePair = async (
  newFact: ExistingFactRow,
  candidate: CandidateFactRow,
  docFilename: string,
  judgeFn: NonNullable<ProcessReconcileOptions["judgeFn"]>,
  existingPairKeys: Set<string>,
  seenPairs: Set<string>,
  counters: { judgeCalls: number; pairsEvaluated: number; ruleResolved: number }
): Promise<PendingRelationRow | null> => {
  if (
    newFact.documentId === candidate.documentId ||
    newFact.id === candidate.id
  ) {
    return null;
  }

  if (
    !isCandidatePredicateMatch(
      newFact.predicate,
      candidate.predicate,
      newFact.factTypeId,
      candidate.factTypeId
    )
  ) {
    return null;
  }

  const pair = canonicalizePair(newFact, candidate);
  const pairKey = `${pair.factAId}|${pair.factBId}`;
  if (existingPairKeys.has(pairKey) || seenPairs.has(pairKey)) {
    return null;
  }
  seenPairs.add(pairKey);
  counters.pairsEvaluated++;

  // Order for the rule check / judge: new fact first, preserving
  // document semantics (A = new doc, B = existing store)
  const detailNew = toFactDetail(newFact);
  const detailCand = toFactDetail(candidate);

  const ruleResult = ruleReconcile(detailNew, detailCand);
  if (!ruleResult.escalate) {
    counters.ruleResolved++;
    return {
      confidence: ruleResult.decision.confidence,
      explanation: ruleResult.decision.explanation,
      factAId: pair.factAId,
      factBId: pair.factBId,
      method: "rule",
      relationType: ruleResult.decision.relationType,
    };
  }

  counters.judgeCalls++;
  let judgeResult: PendingRelationRow;
  try {
    const result = await judgeFn(
      { factA: detailNew, factB: detailCand },
      {
        docA: { filename: docFilename },
        docB: { filename: candidate.candidateFilename ?? "Document B" },
      }
    );
    judgeResult = {
      confidence: result.confidence,
      explanation: result.explanation,
      factAId: pair.factAId,
      factBId: pair.factBId,
      method: "llm_judge",
      relationType: result.relationType,
    };
  } catch (judgeErr: unknown) {
    const judgeMsg =
      judgeErr instanceof Error ? judgeErr.message : String(judgeErr);
    console.warn(
      `[Reconcile] judge call failed for pair ${pair.factAId}|${pair.factBId}: ${judgeMsg} — recording uncertain`
    );
    judgeResult = {
      confidence: 0.2,
      explanation: `LLM judge call failed: ${judgeMsg}`,
      factAId: pair.factAId,
      factBId: pair.factBId,
      method: "llm_judge",
      relationType: "uncertain",
    };
  }

  if (judgeResult.relationType === "uncertain") {
    console.warn(
      `[Reconcile] uncertain relationship: factA=${pair.factAId} factB=${pair.factBId} — ${judgeResult.explanation.slice(0, 160)}`
    );
  }
  return judgeResult;
};

export const processReconcileJob = async (
  jobData: ReconcileJob,
  options?: ProcessReconcileOptions
): Promise<ReconcileResult> => {
  const thresholds = getReconcileThresholds({
    matchCandidates: options?.matchCandidates,
    matchDistance: options?.matchDistance,
    reconcileConcurrency: options?.reconcileConcurrency,
  });
  const embedFn = options?.embedFn ?? buildMatchEmbeddingQuery;
  const judgeFn = options?.judgeFn ?? defaultJudgeFn;
  const { documentId } = jobData;

  const counters = { judgeCalls: 0, pairsEvaluated: 0, ruleResolved: 0 };

  try {
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
      .set({ errorMessage: null, status: "reconciling" })
      .where(eq(documents.id, documentId));
    startStage(documentId);

    publishProgress(documentId, 0, 1, "reconciling");

    const allDocFacts = await loadDocumentFacts(documentId);
    const newFacts = allDocFacts.filter((f) => f.entityId && f.embedding);
    const skippedNoEntity = allDocFacts.filter((f) => !f.entityId).length;
    const skippedNoEmbedding = allDocFacts.filter(
      (f) => f.entityId && !f.embedding
    ).length;

    const existingPairKeys = await loadExistingPairKeys(documentId);

    if (newFacts.length === 0) {
      await db
        .update(documents)
        .set({ errorMessage: null, status: "done" })
        .where(eq(documents.id, documentId));
      publishProgress(documentId, 1, 1, "done");

      console.log(
        `[Reconcile] documentId=${documentId} factsToMatch=0 (skippedNoEntity=${skippedNoEntity}, skippedNoEmbedding=${skippedNoEmbedding}) — nothing to reconcile`
      );

      return {
        documentId,
        factsMatched: 0,
        judgeCalls: 0,
        pairsEvaluated: 0,
        relationshipsCreated: 0,
        ruleResolved: 0,
        skippedNoEmbedding,
        skippedNoEntity,
        success: true,
      };
    }

    // One batched embed call for all query-side inputs (RETRIEVAL_QUERY pairs
    // against stored RETRIEVAL_DOCUMENT vectors; same model/dim, L2 both sides)
    const queryEmbeddings = await embedFn(
      newFacts.map((f) =>
        buildMatchEmbeddingInput({
          entityName: f.entityName,
          predicate: f.predicate,
          value: f.value,
        })
      ),
      { taskType: EMBED_QUERY_TASK_TYPE }
    );

    console.log(
      `[Reconcile] documentId=${documentId} factsToMatch=${newFacts.length} — only matching new facts, not reprocessing existing documents`
    );

    const pendingRows: Array<{
      confidence: number;
      explanation: string;
      factAId: string;
      factBId: string;
      method: string;
      relationType: string;
    }> = [];
    const seenPairs = new Set<string>();

    await pMap(
      newFacts,
      async (newFact, idx) => {
        if (!(newFact.entityId && newFact.embedding)) {
          return;
        }
        const queryEmbedding = queryEmbeddings[idx];
        if (!queryEmbedding) {
          return;
        }

        const candidates = await findCandidateFacts(
          newFact.entityId,
          documentId,
          queryEmbedding,
          thresholds.matchDistance,
          thresholds.matchCandidates,
          newFact.id
        );

        for (const candidate of candidates) {
          // biome-ignore lint/performance/noAwaitInLoops: candidates are few (<= matchCandidates); concurrency is governed by the outer pMap
          const row = await evaluateCandidatePair(
            newFact,
            candidate,
            doc.filename,
            judgeFn,
            existingPairKeys,
            seenPairs,
            counters
          );
          if (row) {
            pendingRows.push(row);
          }
        }

        publishProgress(documentId, idx + 1, newFacts.length, "reconciling");
      },
      { concurrency: thresholds.reconcileConcurrency }
    );

    const relationshipsCreated = await insertRelationshipRows(pendingRows);

    await db
      .update(documents)
      .set({ errorMessage: null, status: "done" })
      .where(eq(documents.id, documentId));

    publishProgress(documentId, newFacts.length, newFacts.length, "done");

    console.log(
      `[Reconcile] documentId=${documentId} done — pairsEvaluated=${counters.pairsEvaluated} ruleResolved=${counters.ruleResolved} judgeCalls=${counters.judgeCalls} created=${relationshipsCreated}`
    );

    return {
      documentId,
      factsMatched: newFacts.length,
      judgeCalls: counters.judgeCalls,
      pairsEvaluated: counters.pairsEvaluated,
      relationshipsCreated,
      ruleResolved: counters.ruleResolved,
      skippedNoEmbedding,
      skippedNoEntity,
      success: true,
    };
  } catch (fatalErr: unknown) {
    const errorMessage =
      fatalErr instanceof Error ? fatalErr.message : "Unknown reconcile error";

    await db
      .update(documents)
      .set({
        errorMessage,
        status: "failed",
      })
      .where(eq(documents.id, documentId));

    publishProgress(documentId, 0, 1, "failed");

    throw fatalErr;
  }
};

async function buildMatchEmbeddingQuery(
  texts: string[],
  embedOptions?: { taskType?: string }
): Promise<number[][]> {
  const { embedFactBatch } = await import("../pipeline/llm");
  return embedFactBatch(texts, embedOptions);
}

function defaultJudgeFn(
  pair: { factA: FactDetail; factB: FactDetail },
  judgeOptions?: {
    docA?: { filename: string } | null;
    docB?: { filename: string } | null;
  }
): Promise<ReconciliationResult> {
  return judgeFactPair(pair, judgeOptions);
}
