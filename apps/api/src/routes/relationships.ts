import {
  count,
  db,
  desc,
  documents,
  entities,
  eq,
  facts,
  inArray,
  relationships,
} from "@grounded/db";
import { Elysia, t } from "elysia";
import { parsePagination } from "../lib/pagination";

export const relationshipRoutes = new Elysia({ prefix: "/relationships" })
  .get(
    "/",
    async ({ query }) => {
      const { limit: queryLimit, page: queryPage, relationType, type } = query;
      const { limit, offset, page } = parsePagination(
        { limit: queryLimit, page: queryPage },
        { defaultLimit: 20 }
      );

      const filterType = relationType || type;
      const whereClause = filterType
        ? eq(relationships.relationType, filterType)
        : undefined;

      const [countResult] = await db
        .select({ total: count() })
        .from(relationships)
        .where(whereClause);
      const total = Number(countResult?.total ?? 0);

      const relList = await db
        .select()
        .from(relationships)
        .where(whereClause)
        .orderBy(desc(relationships.createdAt))
        .limit(limit)
        .offset(offset);

      if (relList.length === 0) {
        return {
          data: [],
          pagination: {
            limit,
            page,
            total,
            totalPages: Math.ceil(total / limit),
          },
        };
      }

      const factIds = new Set<string>();
      for (const rel of relList) {
        factIds.add(rel.factAId);
        factIds.add(rel.factBId);
      }

      const factsList = await db
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
        .where(inArray(facts.id, Array.from(factIds)));

      const factsMap = new Map(factsList.map((f) => [f.id, f]));

      const data = relList.map((r) => ({
        confidence: r.confidence,
        createdAt: r.createdAt,
        explanation: r.explanation,
        factA: factsMap.get(r.factAId) ?? null,
        factAId: r.factAId,
        factB: factsMap.get(r.factBId) ?? null,
        factBId: r.factBId,
        id: r.id,
        method: r.method,
        relationType: r.relationType,
      }));

      return {
        data,
        pagination: {
          limit,
          page,
          total,
          totalPages: Math.ceil(total / limit),
        },
      };
    },
    {
      query: t.Object({
        limit: t.Optional(t.String()),
        page: t.Optional(t.String()),
        relationType: t.Optional(t.String()),
        type: t.Optional(t.String()),
      }),
    }
  )
  .get(
    "/:id",
    async ({ params: { id }, set }) => {
      const [rel] = await db
        .select()
        .from(relationships)
        .where(eq(relationships.id, id))
        .limit(1);

      if (!rel) {
        set.status = 404;
        return { error: `Relationship ${id} not found` };
      }

      const factsList = await db
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
        .where(inArray(facts.id, [rel.factAId, rel.factBId]));

      const factsMap = new Map(factsList.map((f) => [f.id, f]));

      return {
        confidence: rel.confidence,
        createdAt: rel.createdAt,
        explanation: rel.explanation,
        factA: factsMap.get(rel.factAId) ?? null,
        factAId: rel.factAId,
        factB: factsMap.get(rel.factBId) ?? null,
        factBId: rel.factBId,
        id: rel.id,
        method: rel.method,
        relationType: rel.relationType,
      };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  );
