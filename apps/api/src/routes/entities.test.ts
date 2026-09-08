import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import {
  db,
  documents,
  entities,
  entityAliases,
  eq,
  facts,
  factTypes,
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
  console.warn("⚠️ Skipping entities route tests: Postgres is not reachable.");
  dbAvailable = false;
}

describe.skipIf(!dbAvailable)("Entities API routes (/entities)", () => {
  let docId: string;
  let entity1Id: string;
  let entity2Id: string;
  let factTypeId: string;

  beforeAll(async () => {
    // 1. Seed document
    const [doc] = await db
      .insert(documents)
      .values({
        filename: "entity_test_doc.pdf",
        filePath: "/tmp/entity_test_doc.pdf",
        pageCount: 2,
        status: "done",
      })
      .returning();
    docId = doc.id;

    // 2. Seed fact type
    const [ft] = await db
      .insert(factTypes)
      .values({
        description: "Headquarters location",
        name: "HQ",
      })
      .returning();
    factTypeId = ft.id;

    // 3. Seed Entity 1: Wayne Enterprises
    const [ent1] = await db
      .insert(entities)
      .values({
        canonicalName: "Wayne Enterprises",
        contextSample: "A multi-billion dollar tech enterprise",
        entityType: "organization",
      })
      .returning();
    entity1Id = ent1.id;

    // 4. Seed Entity 2: Stark Industries
    const [ent2] = await db
      .insert(entities)
      .values({
        canonicalName: "Stark Industries",
        contextSample: "Defense and technology giant",
        entityType: "organization",
      })
      .returning();
    entity2Id = ent2.id;

    // 5. Seed Aliases for Entity 1
    await db.insert(entityAliases).values([
      {
        documentId: docId,
        entityId: entity1Id,
        surfaceForm: "Wayne Corp",
      },
      {
        documentId: docId,
        entityId: entity1Id,
        surfaceForm: "Wayne Ent",
      },
    ]);

    // 6. Seed Facts for Entity 1
    await db.insert(facts).values([
      {
        confidence: 0.95,
        documentId: docId,
        entityId: entity1Id,
        factTypeId,
        predicate: "headquarters",
        rawValue: "Gotham City",
        sourceChunkIndex: 0,
        sourcePage: 1,
        sourceQuote: "headquartered in Gotham City",
        sourceQuoteValid: true,
        value: "Gotham City",
      },
      {
        confidence: 0.9,
        documentId: docId,
        entityId: entity1Id,
        factTypeId,
        predicate: "founder",
        rawValue: "Thomas Wayne",
        sourceChunkIndex: 1,
        sourcePage: 1,
        sourceQuote: "founded by Thomas Wayne",
        sourceQuoteValid: true,
        value: "Thomas Wayne",
      },
    ]);
  });

  afterAll(async () => {
    if (!dbAvailable) {
      return;
    }
    if (docId) {
      await db.delete(facts).where(eq(facts.documentId, docId));
      await db.delete(entityAliases).where(eq(entityAliases.documentId, docId));
      await db.delete(documents).where(eq(documents.id, docId));
    }
    if (entity1Id) {
      await db.delete(entities).where(eq(entities.id, entity1Id));
    }
    if (entity2Id) {
      await db.delete(entities).where(eq(entities.id, entity2Id));
    }
    if (factTypeId) {
      await db.delete(factTypes).where(eq(factTypes.id, factTypeId));
    }
  });

  describe("GET /entities", () => {
    it("returns list of entities with factCount and aliasCount", async () => {
      const res = await app.handle(
        new Request("http://localhost:3000/entities")
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: {
          aliasCount: number;
          canonicalName: string;
          factCount: number;
          id: string;
        }[];
        pagination: { total: number };
      };
      expect(json.pagination.total).toBeGreaterThanOrEqual(2);

      const wayne = json.data.find((e) => e.id === entity1Id);
      expect(wayne).toBeDefined();
      expect(wayne?.canonicalName).toBe("Wayne Enterprises");
      expect(wayne?.factCount).toBe(2);
      expect(wayne?.aliasCount).toBe(2);

      const stark = json.data.find((e) => e.id === entity2Id);
      expect(stark).toBeDefined();
      expect(stark?.factCount).toBe(0);
      expect(stark?.aliasCount).toBe(0);
    });

    it("supports search filter by canonicalName", async () => {
      const res = await app.handle(
        new Request("http://localhost:3000/entities?search=Wayne")
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: { id: string; canonicalName: string }[];
        pagination: { total: number };
      };
      expect(json.data.length).toBe(1);
      expect(json.data[0].id).toBe(entity1Id);
      expect(json.data[0].canonicalName).toBe("Wayne Enterprises");
    });

    it("escapes SQL wildcards (% and _) in search filter", async () => {
      const res = await app.handle(
        new Request("http://localhost:3000/entities?search=%25")
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: { id: string; canonicalName: string }[];
        pagination: { total: number };
      };
      expect(json.data.length).toBe(0);
      expect(json.pagination.total).toBe(0);
    });

    it("supports pagination controls", async () => {
      const res = await app.handle(
        new Request("http://localhost:3000/entities?limit=1&page=1")
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        data: unknown[];
        pagination: {
          limit: number;
          page: number;
          total: number;
          totalPages: number;
        };
      };
      expect(json.data.length).toBe(1);
      expect(json.pagination.limit).toBe(1);
      expect(json.pagination.page).toBe(1);
      expect(json.pagination.totalPages).toBeGreaterThanOrEqual(2);
    });
  });

  describe("GET /entities/:id", () => {
    it("returns 404 for non-existent entity", async () => {
      const res = await app.handle(
        new Request(
          "http://localhost:3000/entities/00000000-0000-0000-0000-000000000000"
        )
      );
      expect(res.status).toBe(404);
      const json = (await res.json()) as { error: string };
      expect(json.error).toContain("not found");
    });

    it("returns entity details, aliases list, and paginated facts", async () => {
      const res = await app.handle(
        new Request(`http://localhost:3000/entities/${entity1Id}`)
      );
      expect(res.status).toBe(200);
      const json = (await res.json()) as {
        aliases: { alias: string; documentFilename: string }[];
        canonicalName: string;
        facts: {
          data: { predicate: string; rawValue: string }[];
          pagination: { total: number };
        };
        id: string;
      };

      expect(json.id).toBe(entity1Id);
      expect(json.canonicalName).toBe("Wayne Enterprises");

      // Verify aliases
      expect(json.aliases.length).toBe(2);
      expect(json.aliases.some((a) => a.alias === "Wayne Corp")).toBe(true);
      expect(json.aliases[0].documentFilename).toBe("entity_test_doc.pdf");

      // Verify facts
      expect(json.facts.pagination.total).toBe(2);
      expect(json.facts.data.length).toBe(2);
      expect(json.facts.data.some((f) => f.predicate === "headquarters")).toBe(
        true
      );
    });
  });
});
