import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  db,
  documents,
  entities,
  entityAliases,
  eq,
  facts,
  ilike,
  inArray,
  or,
} from "@grounded/db";
import dotenv from "dotenv";
import { confirmEntityMatch } from "../pipeline/llm";
import { processResolveJob, pubRedis } from "./resolve";

dotenv.config({ path: resolve(import.meta.dirname, "../../../../.env") });

const hasKey = Boolean(process.env.LLM_API_KEY || process.env.GEMINI_API_KEY);

const makeDeterministicEmbedding = (seed: string): number[] => {
  const vec = new Array(1536).fill(0);
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 1_000_000_007;
  }
  const idx1 = Math.abs(hash) % 1536;
  const idx2 = (idx1 + 1) % 1536;
  vec[idx1] = 0.8;
  vec[idx2] = 0.6; // 0.8^2 + 0.6^2 = 1.0 (unit length)
  return vec;
};

// Deterministic embedding lookup for tests
const mockEmbedFn = (texts: string[]): Promise<number[][]> =>
  Promise.resolve(
    texts.map((text) => {
      const lower = text.toLowerCase();
      if (lower.includes("apple")) {
        // Both Apple Inc. and Apple Records embed close to each other
        const base = new Array(1536).fill(0);
        base[10] = 0.8;
        base[11] = 0.6;
        return base;
      }
      if (lower.includes("acme")) {
        const base = new Array(1536).fill(0);
        base[20] = 0.8;
        base[21] = 0.6;
        return base;
      }
      return makeDeterministicEmbedding(text);
    })
  );

describe("Phase-3 Entity Resolution Integration Suite", () => {
  const createdDocIds: string[] = [];

  const cleanup = async () => {
    if (createdDocIds.length > 0) {
      await db.delete(documents).where(inArray(documents.id, createdDocIds));
    }
    await db
      .delete(entities)
      .where(
        or(
          ilike(entities.canonicalName, "%acme%"),
          ilike(entities.canonicalName, "%apple%"),
          eq(entities.canonicalName, "Unresolved Entity")
        )
      );
  };

  beforeAll(async () => {
    await cleanup();
  });

  afterAll(async () => {
    await cleanup();
    await pubRedis.quit().catch(() => {
      // Ignored: cleanup
    });
  });

  test("I1: Within-document resolution clusters surface forms and backfills facts", async () => {
    const [doc] = await db
      .insert(documents)
      .values({
        filename: "doc-within.pdf",
        filePath: "/tmp/doc-within.pdf",
        status: "extracted",
      })
      .returning();
    createdDocIds.push(doc.id);

    // Insert facts with various surface forms of Acme
    const [f1, f2, f3] = await db
      .insert(facts)
      .values([
        {
          confidence: 0.95,
          documentId: doc.id,
          predicate: "revenue",
          qualifiers: {
            _entity: {
              context: "Acme Corp reported Q3 earnings of $10M.",
              name: "Acme Corp",
              type: "organization",
            },
          },
          rawValue: "$10M",
          sourcePage: 1,
          sourceQuote: "Acme Corp reported Q3 earnings of $10M.",
          value: "10000000",
        },
        {
          confidence: 0.92,
          documentId: doc.id,
          predicate: "operating_income",
          qualifiers: {
            _entity: {
              context:
                "Acme Corporation expanded operations across North America.",
              name: "Acme Corporation",
              type: "organization",
            },
          },
          rawValue: "$2M",
          sourcePage: 2,
          sourceQuote:
            "Acme Corporation expanded operations across North America.",
          value: "2000000",
        },
        {
          confidence: 0.88,
          documentId: doc.id,
          predicate: "headquarters",
          qualifiers: {
            _entity: {
              context: "The Acme Corporation is based in California.",
              name: "The Acme Corporation",
              type: "organization",
            },
          },
          rawValue: "California",
          sourcePage: 3,
          sourceQuote: "The Acme Corporation is based in California.",
          value: "California",
        },
      ])
      .returning();

    const result = await processResolveJob(
      { documentId: doc.id },
      {
        confirmFn: async () => ({ reasoning: "Same entity", same: true }),
        embedFn: mockEmbedFn,
      }
    );

    expect(result.success).toBe(true);
    expect(result.entitiesResolved).toBe(1);
    expect(result.factsLinked).toBe(3);

    // Check document status
    const [updatedDoc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, doc.id));
    expect(updatedDoc.status).toBe("resolved");

    // Check all facts have non-null entityId and point to same entity
    const updatedFacts = await db
      .select()
      .from(facts)
      .where(inArray(facts.id, [f1.id, f2.id, f3.id]));

    expect(updatedFacts).toHaveLength(3);
    const entityId = updatedFacts[0]?.entityId;
    expect(entityId).not.toBeNull();
    expect(updatedFacts[1]?.entityId).toBe(entityId);
    expect(updatedFacts[2]?.entityId).toBe(entityId);

    // Check canonical name
    const [entity] = await db
      .select()
      .from(entities)
      .where(eq(entities.id, entityId as string));
    expect(entity).toBeDefined();
    expect(entity.canonicalName).toBe("Acme Corporation");

    // Check entity_aliases populated with all surface forms
    const aliases = await db
      .select()
      .from(entityAliases)
      .where(eq(entityAliases.documentId, doc.id));

    const aliasForms = aliases.map((a) => a.surfaceForm);
    expect(aliasForms).toContain("Acme Corp");
    expect(aliasForms).toContain("Acme Corporation");
    expect(aliasForms).toContain("The Acme Corporation");
  });

  test("I2: Across-document linking resolves separate docs to one entity (Exit Criterion 1)", async () => {
    // Document A
    const [docA] = await db
      .insert(documents)
      .values({
        filename: "starter-doc-a.pdf",
        filePath: "/tmp/starter-doc-a.pdf",
        status: "extracted",
      })
      .returning();
    createdDocIds.push(docA.id);

    const [factA] = await db
      .insert(facts)
      .values([
        {
          confidence: 0.95,
          documentId: docA.id,
          predicate: "net_income",
          qualifiers: {
            _entity: {
              context: "Acme Corp announced record net income.",
              name: "Acme Corp",
              type: "organization",
            },
          },
          rawValue: "$500M",
          sourcePage: 1,
          sourceQuote: "Acme Corp announced record net income.",
          value: "500000000",
        },
      ])
      .returning();

    // Document B
    const [docB] = await db
      .insert(documents)
      .values({
        filename: "starter-doc-b.pdf",
        filePath: "/tmp/starter-doc-b.pdf",
        status: "extracted",
      })
      .returning();
    createdDocIds.push(docB.id);

    const [factB] = await db
      .insert(facts)
      .values([
        {
          confidence: 0.91,
          documentId: docB.id,
          predicate: "employee_count",
          qualifiers: {
            _entity: {
              context: "Acme Corporation employs over 12,000 staff worldwide.",
              name: "Acme Corporation",
              type: "organization",
            },
          },
          rawValue: "12,000",
          sourcePage: 1,
          sourceQuote: "Acme Corporation employs over 12,000 staff worldwide.",
          value: "12000",
        },
      ])
      .returning();

    // Resolve Doc A
    await processResolveJob(
      { documentId: docA.id },
      {
        confirmFn: async () => ({
          reasoning: "Confirmed match",
          same: true,
        }),
        embedFn: mockEmbedFn,
      }
    );

    // Resolve Doc B
    await processResolveJob(
      { documentId: docB.id },
      {
        confirmFn: ({ nameA, nameB }) => {
          const isAcme =
            nameA.toLowerCase().includes("acme") &&
            nameB.toLowerCase().includes("acme");
          return Promise.resolve({
            reasoning: isAcme ? "Both refer to Acme" : "Different companies",
            same: isAcme,
          });
        },
        embedFn: mockEmbedFn,
      }
    );

    // Both facts should point to the SAME entity
    const [updatedFactA] = await db
      .select()
      .from(facts)
      .where(eq(facts.id, factA.id));
    const [updatedFactB] = await db
      .select()
      .from(facts)
      .where(eq(facts.id, factB.id));

    expect(updatedFactA.entityId).not.toBeNull();
    expect(updatedFactB.entityId).not.toBeNull();
    expect(updatedFactA.entityId).toBe(updatedFactB.entityId);

    // Check entity_aliases has rows for both documents pointing to same entity
    const aliasesA = await db
      .select()
      .from(entityAliases)
      .where(eq(entityAliases.documentId, docA.id));
    const aliasesB = await db
      .select()
      .from(entityAliases)
      .where(eq(entityAliases.documentId, docB.id));

    expect(aliasesA.length).toBeGreaterThanOrEqual(1);
    expect(aliasesB.length).toBeGreaterThanOrEqual(1);
    expect(aliasesA[0]?.entityId).toBe(updatedFactA.entityId as string);
    expect(aliasesB[0]?.entityId).toBe(updatedFactA.entityId as string);
  });

  test("I3: Negative test: Similar names (Apple Inc. vs Apple Records) remain distinct (Exit Criterion 2)", async () => {
    // Doc with Apple Inc.
    const [docAppleInc] = await db
      .insert(documents)
      .values({
        filename: "apple-inc.pdf",
        filePath: "/tmp/apple-inc.pdf",
        status: "extracted",
      })
      .returning();
    createdDocIds.push(docAppleInc.id);

    const [factAppleInc] = await db
      .insert(facts)
      .values([
        {
          confidence: 0.99,
          documentId: docAppleInc.id,
          predicate: "market_cap",
          qualifiers: {
            _entity: {
              context:
                "Apple Inc. designs, manufactures, and markets smartphones, personal computers, and tablets.",
              name: "Apple Inc.",
              type: "organization",
            },
          },
          rawValue: "$3T",
          sourcePage: 1,
          sourceQuote:
            "Apple Inc. designs, manufactures, and markets smartphones.",
          value: "3000000000000",
        },
      ])
      .returning();

    // Doc with Apple Records
    const [docAppleRecords] = await db
      .insert(documents)
      .values({
        filename: "apple-records.pdf",
        filePath: "/tmp/apple-records.pdf",
        status: "extracted",
      })
      .returning();
    createdDocIds.push(docAppleRecords.id);

    const [factAppleRecords] = await db
      .insert(facts)
      .values([
        {
          confidence: 0.94,
          documentId: docAppleRecords.id,
          predicate: "record_label",
          qualifiers: {
            _entity: {
              context:
                "Apple Records was founded by the Beatles in 1968 as a record label.",
              name: "Apple Records",
              type: "organization",
            },
          },
          rawValue: "Beatles",
          sourcePage: 1,
          sourceQuote: "Apple Records was founded by the Beatles in 1968.",
          value: "Beatles",
        },
      ])
      .returning();

    // Resolve Apple Inc.
    await processResolveJob(
      { documentId: docAppleInc.id },
      {
        confirmFn: async () => ({ reasoning: "Initial entity", same: true }),
        embedFn: mockEmbedFn,
      }
    );

    // Resolve Apple Records with confirmation returning NO for Apple Inc. vs Apple Records
    await processResolveJob(
      { documentId: docAppleRecords.id },
      {
        confirmFn: ({ nameA, nameB }) => {
          const isInc = nameA.includes("Inc") || nameB.includes("Inc");
          const isRecords =
            nameA.includes("Records") || nameB.includes("Records");
          if (isInc && isRecords) {
            return Promise.resolve({
              reasoning:
                "Apple Inc. is a consumer electronics firm while Apple Records is a record label founded by The Beatles.",
              same: false,
            });
          }
          return Promise.resolve({ reasoning: "Same entity", same: true });
        },
        embedFn: mockEmbedFn,
      }
    );

    const [updatedInc] = await db
      .select()
      .from(facts)
      .where(eq(facts.id, factAppleInc.id));
    const [updatedRecords] = await db
      .select()
      .from(facts)
      .where(eq(facts.id, factAppleRecords.id));

    // Both must be non-null and DIFFERENT entity IDs
    expect(updatedInc.entityId).not.toBeNull();
    expect(updatedRecords.entityId).not.toBeNull();
    expect(updatedInc.entityId).not.toBe(updatedRecords.entityId);

    // Verify distinct canonical names in entities table
    const [entityInc] = await db
      .select()
      .from(entities)
      .where(eq(entities.id, updatedInc.entityId as string));
    const [entityRecords] = await db
      .select()
      .from(entities)
      .where(eq(entities.id, updatedRecords.entityId as string));

    expect(entityInc.canonicalName).toBe("Apple Inc.");
    expect(entityRecords.canonicalName).toBe("Apple Records");
  });

  test("I4 & I5: Every fact has non-null entityId and entity_aliases populated (Criteria 3 & 4)", async () => {
    const allFacts = await db
      .select()
      .from(facts)
      .where(inArray(facts.documentId, createdDocIds));

    expect(allFacts.length).toBeGreaterThan(0);
    for (const fact of allFacts) {
      expect(fact.entityId).not.toBeNull();
    }

    const allAliases = await db
      .select()
      .from(entityAliases)
      .where(inArray(entityAliases.documentId, createdDocIds));

    expect(allAliases.length).toBeGreaterThan(0);
  });

  test("I6: Idempotency - re-running resolve-document on same doc produces consistent results", async () => {
    const [testDocId] = createdDocIds;
    if (!testDocId) {
      throw new Error("No test document available");
    }

    const aliasesBefore = await db
      .select()
      .from(entityAliases)
      .where(eq(entityAliases.documentId, testDocId));

    // Re-run resolution
    const result = await processResolveJob(
      { documentId: testDocId },
      {
        confirmFn: async () => ({ reasoning: "Match", same: true }),
        embedFn: mockEmbedFn,
      }
    );

    expect(result.success).toBe(true);

    const aliasesAfter = await db
      .select()
      .from(entityAliases)
      .where(eq(entityAliases.documentId, testDocId));

    // Alias counts must not duplicate
    expect(aliasesAfter.length).toBe(aliasesBefore.length);
  });

  test("I7: Empty document (0 facts) resolves gracefully", async () => {
    const [emptyDoc] = await db
      .insert(documents)
      .values({
        filename: "empty-doc.pdf",
        filePath: "/tmp/empty-doc.pdf",
        status: "extracted",
      })
      .returning();
    createdDocIds.push(emptyDoc.id);

    const result = await processResolveJob({ documentId: emptyDoc.id });
    expect(result.success).toBe(true);
    expect(result.entitiesResolved).toBe(0);
    expect(result.factsLinked).toBe(0);

    const [resolvedDoc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, emptyDoc.id));
    expect(resolvedDoc.status).toBe("resolved");
  });

  test("I8: Non-existent document throws descriptive Error", async () => {
    await expect(
      processResolveJob({ documentId: "00000000-0000-0000-0000-000000000000" })
    ).rejects.toThrow("not found in database");
  });

  // Optional live test against Merge Gateway LLM if keys are configured
  if (hasKey) {
    test("I9: Live LLM confirmation distinguishes entities and confirms matches", async () => {
      // Live call for identical entities
      const matchResult = await confirmEntityMatch({
        contextA: "Acme Corp is a supplier of roadrunner traps.",
        contextB:
          "Acme Corporation is an industrial manufacturing company that makes anvils.",
        nameA: "Acme Corp",
        nameB: "Acme Corporation",
      });

      expect(typeof matchResult.same).toBe("boolean");
      expect(typeof matchResult.reasoning).toBe("string");

      // Live call for different entities with similar name
      const diffResult = await confirmEntityMatch({
        contextA: "Apple Inc. designs and sells the iPhone, iPad, and Mac.",
        contextB:
          "Apple Corps and its label Apple Records were founded by The Beatles in London.",
        nameA: "Apple Inc.",
        nameB: "Apple Records",
      });

      expect(diffResult.same).toBe(false);
      expect(diffResult.reasoning.length).toBeGreaterThan(0);
    }, 30_000);
  }
});
