import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import {
  db,
  documents,
  entities,
  eq,
  facts,
  factTypes,
  pageChunks,
  relationships,
  sql,
} from "@grounded/db";

mock.module("../lib/queue", () => ({
  addParseJob: mock(async () => "mock-job-id"),
  closeQueue: mock(async () => {
    // No-op queue close in unit tests
  }),
}));

const { app } = await import("../index");

let dbAvailable = false;
try {
  await db.execute(sql`SELECT 1`);
  dbAvailable = true;
} catch {
  console.warn("⚠️ Skipping facts route tests: Postgres is not reachable.");
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)("Facts API routes (/facts)", () => {
  let docId: string;
  let entityId: string;
  let factTypeId: string;
  let fact1Id: string;
  let fact2Id: string;
  let fact3Id: string;
  let relId: string;

  beforeAll(async () => {
    // 1. Seed document
    const [doc] = await db
      .insert(documents)
      .values({
        filename: "financial_report_2024.pdf",
        filePath: "/tmp/financial_report_2024.pdf",
        pageCount: 5,
        status: "done",
      })
      .returning();
    docId = doc.id;

    // 2. Seed entity
    const [ent] = await db
      .insert(entities)
      .values({
        canonicalName: "Acme Holdings",
        contextSample: "A conglomerate founded in 1990",
        entityType: "organization",
      })
      .returning();
    entityId = ent.id;

    // 3. Seed fact type
    const [ft] = await db
      .insert(factTypes)
      .values({
        description: "Annual corporate revenue",
        name: "Revenue",
      })
      .returning();
    factTypeId = ft.id;

    // 4. Seed chunk for page 1, chunk 0
    await db.insert(pageChunks).values({
      chunkIndex: 0,
      documentId: docId,
      imagePath: "/renders/page1.png",
      pageNumber: 1,
      positionData: { bbox: [10, 20, 100, 50] },
      rawText: "Acme Holdings recorded revenue of $50M in FY2024.",
    });

    // 5. Seed Fact 1 (with chunk)
    const [f1] = await db
      .insert(facts)
      .values({
        confidence: 0.95,
        currency: "USD",
        documentId: docId,
        entityId,
        factTypeId,
        predicate: "revenue",
        rawValue: "$50M",
        sourceChunkIndex: 0,
        sourcePage: 1,
        sourceQuote: "revenue of $50M in FY2024",
        sourceQuoteValid: true,
        timeScope: "FY2024",
        unit: "USD",
        value: "50000000",
      })
      .returning();
    fact1Id = f1.id;

    // 6. Seed Fact 2 (without chunk in pageChunks)
    const [f2] = await db
      .insert(facts)
      .values({
        confidence: 0.9,
        currency: "USD",
        documentId: docId,
        entityId,
        factTypeId,
        predicate: "revenue",
        rawValue: "$50,000,000",
        sourceChunkIndex: 99,
        sourcePage: 2,
        sourceQuote: "total sales reached $50,000,000",
        sourceQuoteValid: true,
        timeScope: "FY2024",
        unit: "USD",
        value: "50000000",
      })
      .returning();
    fact2Id = f2.id;

    // 7. Seed Fact 3 (different predicate, no relationships)
    const [f3] = await db
      .insert(facts)
      .values({
        confidence: 0.88,
        documentId: docId,
        entityId,
        factTypeId,
        predicate: "employee_count",
        rawValue: "1,200",
        sourceChunkIndex: 99,
        sourcePage: 3,
        sourceQuote: "employing 1,200 full-time staff",
        sourceQuoteValid: true,
        timeScope: "2024",
        unit: "count",
        value: "1200",
      })
      .returning();
    fact3Id = f3.id;

    // 8. Seed Relationship between Fact 1 and Fact 2
    const [rel] = await db
      .insert(relationships)
      .values({
        confidence: 0.98,
        explanation: "Both state FY2024 revenue is $50M",
        factAId: fact1Id,
        factBId: fact2Id,
        method: "rule",
        relationType: "corroborates",
      })
      .returning();
    relId = rel.id;
  });

  afterAll(async () => {
    if (!dbAvailable) {
      return;
    }
    if (relId) {
      await db.delete(relationships).where(eq(relationships.id, relId));
    }
    if (docId) {
      await db.delete(facts).where(eq(facts.documentId, docId));
      await db.delete(pageChunks).where(eq(pageChunks.documentId, docId));
      await db.delete(documents).where(eq(documents.id, docId));
    }
    if (entityId) {
      await db.delete(entities).where(eq(entities.id, entityId));
    }
    if (factTypeId) {
      await db.delete(factTypes).where(eq(factTypes.id, factTypeId));
    }
  });

  describe("GET /facts", () => {
    it("returns facts with total and supports filters", async () => {
      const res = await app.handle(
        new Request(
          `http://localhost:3000/facts?documentId=${docId}&predicate=revenue`
        )
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: { id: string; predicate: string }[];
        total: number;
      };
      expect(json.total).toBe(2);
      expect(json.data.length).toBe(2);
      expect(json.data.every((f) => f.predicate === "revenue")).toBe(true);
    });

    it("supports pagination params", async () => {
      const res = await app.handle(
        new Request(
          `http://localhost:3000/facts?documentId=${docId}&limit=1&page=1`
        )
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: unknown[];
        total: number;
      };
      expect(json.total).toBe(3);
      expect(json.data.length).toBe(1);
    });
  });

  describe("GET /facts/:id", () => {
    it("returns 404 for non-existent fact", async () => {
      const res = await app.handle(
        new Request(
          "http://localhost:3000/facts/00000000-0000-0000-0000-000000000000"
        )
      );
      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: string };
      expect(json.error).toContain("not found");
    });

    it("returns fact with joins and chunk details when chunk exists", async () => {
      const res = await app.handle(
        new Request(`http://localhost:3000/facts/${fact1Id}`)
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        chunk: { imagePath: string; rawText: string } | null;
        documentFilename: string;
        entityCanonicalName: string;
        factTypeName: string;
        id: string;
        predicate: string;
      };
      expect(json.id).toBe(fact1Id);
      expect(json.predicate).toBe("revenue");
      expect(json.documentFilename).toBe("financial_report_2024.pdf");
      expect(json.entityCanonicalName).toBe("Acme Holdings");
      expect(json.factTypeName).toBe("Revenue");
      expect(json.chunk).not.toBeNull();
      expect(json.chunk?.imagePath).toBe("/renders/page1.png");
      expect(json.chunk?.rawText).toContain("Acme Holdings");
    });

    it("returns fact with chunk as null when chunk does not exist", async () => {
      const res = await app.handle(
        new Request(`http://localhost:3000/facts/${fact2Id}`)
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        chunk: unknown;
        id: string;
      };
      expect(json.id).toBe(fact2Id);
      expect(json.chunk).toBeNull();
    });
  });

  describe("GET /facts/:id/relationships", () => {
    it("returns 404 for non-existent fact", async () => {
      const res = await app.handle(
        new Request(
          "http://localhost:3000/facts/00000000-0000-0000-0000-000000000000/relationships"
        )
      );
      expect(res.status).toBe(404);
    });

    it("returns empty data array when fact has no relationships", async () => {
      const res = await app.handle(
        new Request(`http://localhost:3000/facts/${fact3Id}/relationships`)
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as { data: unknown[] };
      expect(json.data).toEqual([]);
    });

    it("returns relationship with otherFact and role 'factA' when fact is subject", async () => {
      const res = await app.handle(
        new Request(`http://localhost:3000/facts/${fact1Id}/relationships`)
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: {
          confidence: number;
          explanation: string;
          otherFact: { id: string; rawValue: string; documentFilename: string };
          relationType: string;
          role: string;
        }[];
      };
      expect(json.data.length).toBe(1);
      const [item] = json.data;
      expect(item.role).toBe("factA");
      expect(item.relationType).toBe("corroborates");
      expect(item.otherFact.id).toBe(fact2Id);
      expect(item.otherFact.rawValue).toBe("$50,000,000");
      expect(item.otherFact.documentFilename).toBe("financial_report_2024.pdf");
    });

    it("returns relationship with role 'factB' when fact is target", async () => {
      const res = await app.handle(
        new Request(`http://localhost:3000/facts/${fact2Id}/relationships`)
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: {
          otherFact: { id: string };
          role: string;
        }[];
      };
      expect(json.data.length).toBe(1);
      const [first] = json.data;
      expect(first.role).toBe("factB");
      expect(first.otherFact.id).toBe(fact1Id);
    });
  });
});
