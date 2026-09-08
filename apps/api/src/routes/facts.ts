import {
  and,
  asc,
  count,
  db,
  desc,
  documents,
  eq,
  facts,
  factTypes,
  type SQL,
} from "@grounded/db";
import { Elysia, t } from "elysia";

export const factRoutes = new Elysia({ prefix: "/facts" }).get(
  "/",
  async ({ query }) => {
    const { documentId: docId, entityId, limit: queryLimit, predicate } = query;
    const limit = Math.max(1, Math.min(100, Number(queryLimit) || 50));

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

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

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
      .where(whereClause);

    const data = await queryBuilder
      .orderBy(asc(facts.sourcePage), desc(facts.extractedAt))
      .limit(limit);

    return { data, total };
  },
  {
    query: t.Object({
      documentId: t.Optional(t.String()),
      entityId: t.Optional(t.String()),
      limit: t.Optional(t.String()),
      predicate: t.Optional(t.String()),
    }),
  }
);
