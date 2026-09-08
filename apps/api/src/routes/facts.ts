import {
  and,
  asc,
  count,
  db,
  desc,
  documents,
  entities,
  eq,
  facts,
  factTypes,
  inArray,
  or,
  pageChunks,
  relationships,
  type SQL,
} from "@grounded/db";
import { Elysia, t } from "elysia";
import { parsePagination } from "../lib/pagination";

export const factRoutes = new Elysia({ prefix: "/facts" })
  .get(
    "/",
    async ({ query }) => {
      const {
        documentId: docId,
        entityId,
        limit: queryLimit,
        page: queryPage,
        predicate,
      } = query;
      const { limit, offset } = parsePagination(
        { limit: queryLimit, page: queryPage },
        { defaultLimit: 50 }
      );

      const conditions: SQL[] = [];
      if (docId) {
        conditions.push(eq(facts.documentId, docId));
      }
      if (entityId) {
        conditions.push(eq(facts.entityId, entityId));
      }
      if (predicate) {
        conditions.push(eq(facts.predicate, predicate));
      }

      const whereClause =
        conditions.length > 0 ? and(...conditions) : undefined;

      const [countResult] = await db
        .select({ total: count() })
        .from(facts)
        .where(whereClause);
      const total = Number(countResult?.total ?? 0);

      const queryBuilder = db
        .select({
          confidence: facts.confidence,
          currency: facts.currency,
          documentFilename: documents.filename,
          documentId: facts.documentId,
          entityCanonicalName: entities.canonicalName,
          entityId: facts.entityId,
          extractedAt: facts.extractedAt,
          factTypeId: facts.factTypeId,
          factTypeName: factTypes.name,
          id: facts.id,
          predicate: facts.predicate,
          qualifiers: facts.qualifiers,
          rawValue: facts.rawValue,
          sourceChunkIndex: facts.sourceChunkIndex,
          sourcePage: facts.sourcePage,
          sourceQuote: facts.sourceQuote,
          sourceQuoteValid: facts.sourceQuoteValid,
          timeScope: facts.timeScope,
          unit: facts.unit,
          value: facts.value,
        })
        .from(facts)
        .leftJoin(documents, eq(facts.documentId, documents.id))
        .leftJoin(factTypes, eq(facts.factTypeId, factTypes.id))
        .leftJoin(entities, eq(facts.entityId, entities.id))
        .where(whereClause);

      const data = await queryBuilder
        .orderBy(asc(facts.sourcePage), desc(facts.extractedAt))
        .limit(limit)
        .offset(offset);

      return { data, total };
    },
    {
      query: t.Object({
        documentId: t.Optional(t.String()),
        entityId: t.Optional(t.String()),
        limit: t.Optional(t.String()),
        page: t.Optional(t.String()),
        predicate: t.Optional(t.String()),
      }),
    }
  )
  .get(
    "/:id",
    async ({ params: { id }, set }) => {
      const [fact] = await db
        .select({
          confidence: facts.confidence,
          currency: facts.currency,
          documentFilename: documents.filename,
          documentId: facts.documentId,
          entityCanonicalName: entities.canonicalName,
          entityId: facts.entityId,
          extractedAt: facts.extractedAt,
          factTypeId: facts.factTypeId,
          factTypeName: factTypes.name,
          id: facts.id,
          predicate: facts.predicate,
          qualifiers: facts.qualifiers,
          rawValue: facts.rawValue,
          sourceChunkIndex: facts.sourceChunkIndex,
          sourcePage: facts.sourcePage,
          sourceQuote: facts.sourceQuote,
          sourceQuoteValid: facts.sourceQuoteValid,
          timeScope: facts.timeScope,
          unit: facts.unit,
          value: facts.value,
        })
        .from(facts)
        .leftJoin(documents, eq(facts.documentId, documents.id))
        .leftJoin(factTypes, eq(facts.factTypeId, factTypes.id))
        .leftJoin(entities, eq(facts.entityId, entities.id))
        .where(eq(facts.id, id))
        .limit(1);

      if (!fact) {
        set.status = 404;
        return { error: `Fact ${id} not found` };
      }

      let chunk: {
        imagePath: string | null;
        positionData: unknown;
        rawText: string | null;
      } | null = null;

      if (fact.sourceChunkIndex !== null && fact.sourcePage !== null) {
        const [foundChunk] = await db
          .select({
            imagePath: pageChunks.imagePath,
            positionData: pageChunks.positionData,
            rawText: pageChunks.rawText,
          })
          .from(pageChunks)
          .where(
            and(
              eq(pageChunks.documentId, fact.documentId),
              eq(pageChunks.pageNumber, fact.sourcePage),
              eq(pageChunks.chunkIndex, fact.sourceChunkIndex)
            )
          )
          .limit(1);

        if (foundChunk) {
          chunk = foundChunk;
        }
      }

      return {
        ...fact,
        chunk,
      };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  )
  .get(
    "/:id/relationships",
    async ({ params: { id }, set }) => {
      const [fact] = await db
        .select({ id: facts.id })
        .from(facts)
        .where(eq(facts.id, id))
        .limit(1);

      if (!fact) {
        set.status = 404;
        return { error: `Fact ${id} not found` };
      }

      const rels = await db
        .select()
        .from(relationships)
        .where(or(eq(relationships.factAId, id), eq(relationships.factBId, id)))
        .orderBy(desc(relationships.createdAt))
        .limit(100);

      if (rels.length === 0) {
        return { data: [] };
      }

      const otherFactIds = rels.map((r) =>
        r.factAId === id ? r.factBId : r.factAId
      );

      const otherFactsList = await db
        .select({
          confidence: facts.confidence,
          currency: facts.currency,
          documentFilename: documents.filename,
          documentId: facts.documentId,
          entityCanonicalName: entities.canonicalName,
          entityId: facts.entityId,
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
        .leftJoin(documents, eq(facts.documentId, documents.id))
        .leftJoin(entities, eq(facts.entityId, entities.id))
        .where(inArray(facts.id, otherFactIds));

      const otherFactsMap = new Map(otherFactsList.map((f) => [f.id, f]));

      const data = rels.map((r) => {
        const isFactA = r.factAId === id;
        const otherId = isFactA ? r.factBId : r.factAId;
        const otherFact = otherFactsMap.get(otherId) ?? null;

        return {
          confidence: r.confidence,
          createdAt: r.createdAt,
          explanation: r.explanation,
          id: r.id,
          method: r.method,
          otherFact,
          relationType: r.relationType,
          role: isFactA ? ("factA" as const) : ("factB" as const),
        };
      });

      return { data };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  );
