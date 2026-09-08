import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import {
  db,
  documents,
  entities,
  eq,
  facts,
  factTypes,
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
  console.warn(
    "⚠️ Skipping relationships route tests: Postgres is not reachable."
  );
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)(
  "Relationships API routes (/relationships)",
  () => {
    let docId: string;
    let entityId: string;
    let factTypeId: string;
    let factAId: string;
    let factBId: string;
    let factCId: string;
    let rel1Id: string;
    let rel2Id: string;
    let rel3Id: string;

    beforeAll(async () => {
      // 1. Seed document
      const [doc] = await db
        .insert(documents)
        .values({
          filename: "test_filing_2024.pdf",
          filePath: "/tmp/test_filing_2024.pdf",
          pageCount: 3,
          status: "done",
        })
        .returning();
      docId = doc.id;

      // 2. Seed entity
      const [ent] = await db
        .insert(entities)
        .values({
          canonicalName: "Nexus Global",
          contextSample: "A logistics multinational",
          entityType: "organization",
        })
        .returning();
      entityId = ent.id;

      // 3. Seed fact type
      const [ft] = await db
        .insert(factTypes)
        .values({
          description: "Operating margin",
          name: "OperatingMargin",
        })
        .returning();
      factTypeId = ft.id;

      // 4. Seed 3 facts
      const [fA] = await db
        .insert(facts)
        .values({
          confidence: 0.95,
          documentId: docId,
          entityId,
          factTypeId,
          predicate: "operating_margin",
          rawValue: "14.2%",
          sourceChunkIndex: 0,
          sourcePage: 1,
          sourceQuote: "operating margin reached 14.2%",
          value: "0.142",
        })
        .returning();
      factAId = fA.id;

      const [fB] = await db
        .insert(facts)
        .values({
          confidence: 0.92,
          documentId: docId,
          entityId,
          factTypeId,
          predicate: "operating_margin",
          rawValue: "14.20 percent",
          sourceChunkIndex: 0,
          sourcePage: 2,
          sourceQuote: "margin of 14.20 percent recorded",
          value: "0.142",
        })
        .returning();
      factBId = fB.id;

      const [fC] = await db
        .insert(facts)
        .values({
          confidence: 0.89,
          documentId: docId,
          entityId,
          factTypeId,
          predicate: "operating_margin",
          rawValue: "11.5%",
          sourceChunkIndex: 0,
          sourcePage: 3,
          sourceQuote: "adjusted margin was 11.5%",
          value: "0.115",
        })
        .returning();
      factCId = fC.id;

      // 5. Seed relationships of different types
      const [r1] = await db
        .insert(relationships)
        .values({
          confidence: 0.99,
          explanation: "Both report identical 14.2% operating margin",
          factAId,
          factBId,
          method: "rule",
          relationType: "corroborates",
        })
        .returning();
      rel1Id = r1.id;

      const [r2] = await db
        .insert(relationships)
        .values({
          confidence: 0.85,
          explanation: "Discrepancy between 14.2% and 11.5%",
          factAId,
          factBId: factCId,
          method: "llm_judge",
          relationType: "contradicts",
        })
        .returning();
      rel2Id = r2.id;

      const [r3] = await db
        .insert(relationships)
        .values({
          confidence: 0.91,
          explanation: "Reconciled due to adjusted vs GAAP definitions",
          factAId: factBId,
          factBId: factCId,
          method: "both",
          relationType: "reconciled",
        })
        .returning();
      rel3Id = r3.id;
    });

    afterAll(async () => {
      if (!dbAvailable) {
        return;
      }
      await db.delete(relationships).where(eq(relationships.id, rel1Id));
      await db.delete(relationships).where(eq(relationships.id, rel2Id));
      await db.delete(relationships).where(eq(relationships.id, rel3Id));
      if (docId) {
        await db.delete(facts).where(eq(facts.documentId, docId));
        await db.delete(documents).where(eq(documents.id, docId));
      }
      if (entityId) {
        await db.delete(entities).where(eq(entities.id, entityId));
      }
      if (factTypeId) {
        await db.delete(factTypes).where(eq(factTypes.id, factTypeId));
      }
    });

    describe("GET /relationships", () => {
      it("returns relationships list with pagination math", async () => {
        const res = await app.handle(
          new Request("http://localhost:3000/relationships?limit=2&page=1")
        );
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
          data: { id: string }[];
          pagination: {
            limit: number;
            page: number;
            total: number;
            totalPages: number;
          };
        };
        expect(json.pagination.limit).toBe(2);
        expect(json.pagination.page).toBe(1);
        expect(json.pagination.total).toBeGreaterThanOrEqual(3);
        expect(json.pagination.totalPages).toBeGreaterThanOrEqual(2);
        expect(json.data.length).toBe(2);
      });

      it("filters relationships by relationType", async () => {
        const res = await app.handle(
          new Request(
            "http://localhost:3000/relationships?relationType=corroborates"
          )
        );
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
          data: { id: string; relationType: string }[];
        };
        expect(json.data.length).toBeGreaterThanOrEqual(1);
        expect(json.data.every((r) => r.relationType === "corroborates")).toBe(
          true
        );
      });

      it("supports 'type' query alias for relationType", async () => {
        const res = await app.handle(
          new Request("http://localhost:3000/relationships?type=contradicts")
        );
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
          data: { id: string; relationType: string }[];
        };
        expect(json.data.length).toBeGreaterThanOrEqual(1);
        expect(json.data.every((r) => r.relationType === "contradicts")).toBe(
          true
        );
      });

      it("expands both factA and factB with document and entity data", async () => {
        const res = await app.handle(
          new Request(
            "http://localhost:3000/relationships?relationType=corroborates"
          )
        );
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
          data: {
            confidence: number;
            explanation: string;
            factA: {
              documentFilename: string;
              entityCanonicalName: string;
              id: string;
              rawValue: string;
            } | null;
            factB: {
              documentFilename: string;
              entityCanonicalName: string;
              id: string;
              rawValue: string;
            } | null;
            id: string;
            relationType: string;
          }[];
        };
        const r1 = json.data.find((r) => r.id === rel1Id);
        expect(r1).toBeDefined();
        expect(r1?.factA).not.toBeNull();
        expect(r1?.factB).not.toBeNull();
        expect(r1?.factA?.id).toBe(factAId);
        expect(r1?.factA?.rawValue).toBe("14.2%");
        expect(r1?.factA?.documentFilename).toBe("test_filing_2024.pdf");
        expect(r1?.factA?.entityCanonicalName).toBe("Nexus Global");
        expect(r1?.factB?.id).toBe(factBId);
        expect(r1?.factB?.rawValue).toBe("14.20 percent");
        expect(r1?.factB?.documentFilename).toBe("test_filing_2024.pdf");
        expect(r1?.factB?.entityCanonicalName).toBe("Nexus Global");
      });
    });

    describe("GET /relationships/:id", () => {
      it("returns 404 for non-existent relationship", async () => {
        const res = await app.handle(
          new Request(
            "http://localhost:3000/relationships/00000000-0000-0000-0000-000000000000"
          )
        );
        expect(res.status).toBe(404);
        const json = (await res.json()) as { error: string };
        expect(json.error).toContain("not found");
      });

      it("returns single relationship with both facts expanded", async () => {
        const res = await app.handle(
          new Request(`http://localhost:3000/relationships/${rel2Id}`)
        );
        expect(res.status).toBe(200);
        const json = (await res.json()) as {
          explanation: string;
          factA: { id: string; rawValue: string };
          factB: { id: string; rawValue: string };
          id: string;
          relationType: string;
        };
        expect(json.id).toBe(rel2Id);
        expect(json.relationType).toBe("contradicts");
        expect(json.explanation).toBe("Discrepancy between 14.2% and 11.5%");
        expect(json.factA.id).toBe(factAId);
        expect(json.factB.id).toBe(factCId);
      });
    });
  }
);
