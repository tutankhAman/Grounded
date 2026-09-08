import {
  addReconcileJob,
  and,
  type DocumentStatus,
  db,
  documents,
  entities,
  entityAliases,
  eq,
  facts,
  getResolverThresholds,
  inArray,
  isNull,
  type ResolveJob,
  sql,
} from "@grounded/db";
import pMap from "p-map";
import { publishDocumentProgress } from "../lib/redis";
import { confirmEntityMatch, embedFactBatch } from "../pipeline/llm";
import {
  buildEntityEmbeddingInput,
  clusterSurfaceForms,
  type EntityCluster,
  type RawEntityMention,
} from "../pipeline/resolver";

export { pubRedis } from "../lib/redis";

export interface ResolveResult {
  documentId: string;
  entitiesResolved: number;
  factsLinked: number;
  success: boolean;
}

export interface ProcessResolveOptions {
  confirmFn?: (params: {
    contextA?: string | null;
    contextB?: string | null;
    nameA: string;
    nameB: string;
  }) => Promise<{ reasoning: string; same: boolean }>;
  embedFn?: (texts: string[]) => Promise<number[][]>;
  entityMatchThreshold?: number;
  stringSimilarityThreshold?: number;
}

const BACKFILL_CHUNK_SIZE = 250;

const publishProgress = (
  documentId: string,
  current: number,
  total: number,
  status: DocumentStatus
): void => {
  publishDocumentProgress(documentId, {
    progress: { current, total },
    stage: "resolve",
    status,
  });
};

interface FactRow {
  id: string;
  qualifiers: unknown;
  sourceQuote: string;
}

const extractMentionsFromFacts = (docFacts: FactRow[]): RawEntityMention[] =>
  docFacts.map((fact) => {
    const qual =
      fact.qualifiers && typeof fact.qualifiers === "object"
        ? (fact.qualifiers as Record<string, unknown>)
        : {};

    const entityData = (qual._entity ?? qual.entity) as
      | { context?: string; name?: string; type?: string }
      | undefined;

    const rawName = entityData?.name?.trim();
    const name = rawName && rawName.length > 0 ? rawName : "Unknown Entity";
    const type = entityData?.type?.trim() || null;
    const context = entityData?.context?.trim() || fact.sourceQuote || null;

    return {
      context,
      factId: fact.id,
      name,
      type,
    };
  });

interface CandidateEntity {
  canonicalName: string;
  contextSample: string | null;
  distance: number;
  entityType: string | null;
  id: string;
}

const findMatchingEntity = async (
  cluster: EntityCluster,
  embedding: number[],
  matchThreshold: number,
  confirmFn: NonNullable<ProcessResolveOptions["confirmFn"]>
): Promise<string | null> => {
  const vectorStr = `[${embedding.join(",")}]`;

  const candidates: CandidateEntity[] = await db
    .select({
      canonicalName: entities.canonicalName,
      contextSample: entities.contextSample,
      distance: sql<number>`${entities.embedding} <=> ${vectorStr}::vector`,
      entityType: entities.entityType,
      id: entities.id,
    })
    .from(entities)
    .where(sql`${entities.embedding} IS NOT NULL`)
    .orderBy(sql`${entities.embedding} <=> ${vectorStr}::vector`)
    .limit(5);

  const eligible = candidates.filter(
    (cand) => 1 - Number(cand.distance) >= matchThreshold
  );

  if (eligible.length === 0) {
    return null;
  }

  for (const cand of eligible) {
    // biome-ignore lint/performance/noAwaitInLoops: sequential short-circuit avoids unnecessary LLM confirmation calls
    const confirm = await confirmFn({
      contextA: cluster.contextSample,
      contextB: cand.contextSample,
      nameA: cluster.canonicalName,
      nameB: cand.canonicalName,
    });
    if (confirm.same) {
      return cand.id;
    }
  }

  return null;
};

const persistCluster = async (
  documentId: string,
  cluster: EntityCluster,
  embedding: number[],
  targetEntityId: string | null
): Promise<string> => {
  let resolvedEntityId = targetEntityId;

  if (!resolvedEntityId) {
    // Note on entities.embedding persistence:
    // Storing cluster embedding in entities.embedding enables downstream cross-document matching
    // via vector cosine distance (ORDER BY embedding <=> $1 LIMIT 5).
    const [inserted] = await db
      .insert(entities)
      .values({
        canonicalName: cluster.canonicalName,
        contextSample: cluster.contextSample,
        embedding,
        entityType: cluster.entityType,
      })
      .onConflictDoNothing()
      .returning({ id: entities.id });

    if (inserted) {
      resolvedEntityId = inserted.id;
    } else {
      // Conflict on unique lower(canonical_name) index: find existing entity
      const [existing] = await db
        .select({ id: entities.id })
        .from(entities)
        .where(
          sql`lower(${entities.canonicalName}) = lower(${cluster.canonicalName})`
        )
        .limit(1);

      if (!existing) {
        throw new Error(
          `Failed to insert or find entity for ${cluster.canonicalName}`
        );
      }
      resolvedEntityId = existing.id;
    }
  }

  // Insert entity aliases
  const aliasRows = cluster.surfaceForms.map((surfaceForm) => ({
    confidence: 1.0,
    documentId,
    entityId: resolvedEntityId,
    surfaceForm,
  }));

  if (aliasRows.length > 0) {
    await db.insert(entityAliases).values(aliasRows);
  }

  // Backfill facts in chunks
  const { factIds } = cluster;
  const chunkPromises: Promise<unknown>[] = [];
  for (let j = 0; j < factIds.length; j += BACKFILL_CHUNK_SIZE) {
    const chunk = factIds.slice(j, j + BACKFILL_CHUNK_SIZE);
    chunkPromises.push(
      db
        .update(facts)
        .set({ entityId: resolvedEntityId })
        .where(inArray(facts.id, chunk))
    );
  }
  await Promise.all(chunkPromises);

  return resolvedEntityId;
};

const getOrCreateFallbackEntity = async (): Promise<string> => {
  const [existingFallback] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(sql`lower(${entities.canonicalName}) = 'unresolved entity'`)
    .limit(1);

  if (existingFallback) {
    return existingFallback.id;
  }

  const [minted] = await db
    .insert(entities)
    .values({
      canonicalName: "Unresolved Entity",
      contextSample: "Fallback entity for unlinked facts",
      entityType: "unknown",
    })
    .onConflictDoNothing()
    .returning({ id: entities.id });

  if (minted) {
    return minted.id;
  }

  const [found] = await db
    .select({ id: entities.id })
    .from(entities)
    .where(sql`lower(${entities.canonicalName}) = 'unresolved entity'`)
    .limit(1);

  if (!found) {
    throw new Error("Failed to create or retrieve fallback entity");
  }
  return found.id;
};

const linkUnresolvedFacts = async (documentId: string): Promise<number> => {
  const unlinked = await db
    .select({ id: facts.id })
    .from(facts)
    .where(and(eq(facts.documentId, documentId), isNull(facts.entityId)));

  if (unlinked.length === 0) {
    return 0;
  }

  const fallbackEntityId = await getOrCreateFallbackEntity();
  const unlinkedIds = unlinked.map((u) => u.id);
  const unlinkedPromises: Promise<unknown>[] = [];

  for (let j = 0; j < unlinkedIds.length; j += BACKFILL_CHUNK_SIZE) {
    const chunk = unlinkedIds.slice(j, j + BACKFILL_CHUNK_SIZE);
    unlinkedPromises.push(
      db
        .update(facts)
        .set({ entityId: fallbackEntityId })
        .where(inArray(facts.id, chunk))
    );
  }
  await Promise.all(unlinkedPromises);
  return unlinked.length;
};

export const processResolveJob = async (
  jobData: ResolveJob,
  options?: ProcessResolveOptions
): Promise<ResolveResult> => {
  const { documentId } = jobData;
  const thresholds = getResolverThresholds();

  const matchThreshold =
    options?.entityMatchThreshold ?? thresholds.entityMatchThreshold;
  const stringThreshold =
    options?.stringSimilarityThreshold ?? thresholds.stringSimilarityThreshold;
  const confirmFn = options?.confirmFn ?? confirmEntityMatch;
  const embedFn = options?.embedFn ?? embedFactBatch;

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
    .set({ errorMessage: null, status: "resolving" })
    .where(eq(documents.id, documentId));

  try {
    publishProgress(documentId, 0, 1, "resolving");

    // Idempotency: clear previous aliases and fact links for this document
    await db
      .delete(entityAliases)
      .where(eq(entityAliases.documentId, documentId));
    await db
      .update(facts)
      .set({ entityId: null })
      .where(eq(facts.documentId, documentId));

    const docFacts = await db
      .select({
        id: facts.id,
        qualifiers: facts.qualifiers,
        sourceQuote: facts.sourceQuote,
      })
      .from(facts)
      .where(eq(facts.documentId, documentId));

    if (docFacts.length === 0) {
      await db
        .update(documents)
        .set({ errorMessage: null, status: "resolved" })
        .where(eq(documents.id, documentId));
      publishProgress(documentId, 1, 1, "resolved");

      return {
        documentId,
        entitiesResolved: 0,
        factsLinked: 0,
        success: true,
      };
    }

    // 1. Within-document resolution (clustering)
    const mentions = extractMentionsFromFacts(docFacts);
    const clusters = clusterSurfaceForms(mentions, {
      embeddingThreshold: matchThreshold,
      stringThreshold,
    });

    // 2. Embed canonical names + context samples for all clusters
    const clusterInputs = clusters.map((c) =>
      buildEntityEmbeddingInput(c.canonicalName, c.contextSample)
    );
    const embeddings = await embedFn(clusterInputs);

    // 3. Across-document resolution & persistence
    let factsLinkedCount = 0;

    await pMap(
      clusters,
      async (cluster, i) => {
        const embedding = embeddings[i];
        if (!embedding) {
          return;
        }

        const matchedId = await findMatchingEntity(
          cluster,
          embedding,
          matchThreshold,
          confirmFn
        );

        await persistCluster(documentId, cluster, embedding, matchedId);
        factsLinkedCount += cluster.factIds.length;

        publishProgress(documentId, i + 1, clusters.length, "resolving");
      },
      { concurrency: 1 }
    );

    // Fallback check: guarantee every fact has non-null entityId
    const unlinkedCount = await linkUnresolvedFacts(documentId);
    factsLinkedCount += unlinkedCount;

    await db
      .update(documents)
      .set({ errorMessage: null, status: "resolved" })
      .where(eq(documents.id, documentId));

    publishProgress(documentId, clusters.length, clusters.length, "resolved");

    try {
      await addReconcileJob({ documentId });
    } catch {
      // Ignored: best-effort queueing
    }

    return {
      documentId,
      entitiesResolved: clusters.length,
      factsLinked: factsLinkedCount,
      success: true,
    };
  } catch (fatalErr: unknown) {
    const errorMessage =
      fatalErr instanceof Error ? fatalErr.message : "Unknown resolve error";

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
