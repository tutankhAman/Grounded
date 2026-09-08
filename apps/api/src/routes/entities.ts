import {
  asc,
  count,
  db,
  desc,
  documents,
  entities,
  entityAliases,
  eq,
  facts,
  factTypes,
  ilike,
  sql,
} from "@grounded/db";
import { Elysia, t } from "elysia";
import { parsePagination } from "../lib/pagination";

export const entityRoutes = new Elysia({ prefix: "/entities" })
  .get(
    "/",
    async ({ query }) => {
      const { limit: queryLimit, page: queryPage, search } = query;
      const { limit, offset, page } = parsePagination(
        { limit: queryLimit, page: queryPage },
        { defaultLimit: 20 }
      );

      const trimmedSearch = search?.trim();
      const escapedSearch = trimmedSearch?.replace(/[%_\\]/g, "\\$&");
      const whereClause = escapedSearch
        ? ilike(entities.canonicalName, `%${escapedSearch}%`)
        : undefined;

      const [countResult] = await db
        .select({ total: count() })
        .from(entities)
        .where(whereClause);
      const total = Number(countResult?.total ?? 0);

      const data = await db
        .select({
          // Note: "entities"."id" must be explicitly string-quoted to correlate with the outer query,
          // as Drizzle's ${entities.id} inside a subquery context can resolve to the subquery table.
          aliasCount: sql<number>`(SELECT count(*)::int FROM ${entityAliases} WHERE ${entityAliases.entityId} = "entities"."id")`,
          canonicalName: entities.canonicalName,
          contextSample: entities.contextSample,
          createdAt: entities.createdAt,
          entityType: entities.entityType,
          factCount: sql<number>`(SELECT count(*)::int FROM ${facts} WHERE ${facts.entityId} = "entities"."id")`,
          id: entities.id,
        })
        .from(entities)
        .where(whereClause)
        .orderBy(desc(entities.createdAt))
        .limit(limit)
        .offset(offset);

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
        search: t.Optional(t.String()),
      }),
    }
  )
  .get(
    "/:id",
    async ({ params: { id }, query, set }) => {
      const [entity] = await db
        .select()
        .from(entities)
        .where(eq(entities.id, id))
        .limit(1);

      if (!entity) {
        set.status = 404;
        return { error: `Entity ${id} not found` };
      }

      const aliases = await db
        .select({
          alias: entityAliases.surfaceForm,
          createdAt: entityAliases.createdAt,
          documentFilename: documents.filename,
          documentId: entityAliases.documentId,
          id: entityAliases.id,
        })
        .from(entityAliases)
        .leftJoin(documents, eq(entityAliases.documentId, documents.id))
        .where(eq(entityAliases.entityId, id))
        .orderBy(asc(entityAliases.createdAt));

      const { limit: queryLimit, page: queryPage } = query;
      const { limit, offset, page } = parsePagination(
        { limit: queryLimit, page: queryPage },
        { defaultLimit: 20 }
      );

      const [factsCountRes] = await db
        .select({ total: count() })
        .from(facts)
        .where(eq(facts.entityId, id));
      const totalFacts = Number(factsCountRes?.total ?? 0);

      const entityFacts = await db
        .select({
          confidence: facts.confidence,
          currency: facts.currency,
          documentFilename: documents.filename,
          documentId: facts.documentId,
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
        .where(eq(facts.entityId, id))
        .orderBy(asc(facts.sourcePage), desc(facts.extractedAt))
        .limit(limit)
        .offset(offset);

      return {
        ...entity,
        aliases,
        facts: {
          data: entityFacts,
          pagination: {
            limit,
            page,
            total: totalFacts,
            totalPages: Math.ceil(totalFacts / limit),
          },
        },
      };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      query: t.Object({
        limit: t.Optional(t.String()),
        page: t.Optional(t.String()),
      }),
    }
  );
