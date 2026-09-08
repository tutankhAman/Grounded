import { asc, db, desc, documents, eq, facts, factTypes } from "@grounded/db";
import { Elysia, t } from "elysia";

export const factRoutes = new Elysia({ prefix: "/facts" }).get(
  "/",
  async ({ query }) => {
    const limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
    const docId = query.documentId;

    let queryBuilder = db
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
      .$dynamic();

    if (docId) {
      queryBuilder = queryBuilder.where(eq(facts.documentId, docId));
    }

    const data = await queryBuilder
      .orderBy(asc(facts.sourcePage), desc(facts.extractedAt))
      .limit(limit);

    return { data };
  },
  {
    query: t.Object({
      documentId: t.Optional(t.String()),
      limit: t.Optional(t.String()),
    }),
  }
);
