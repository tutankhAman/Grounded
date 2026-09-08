import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  and,
  db,
  documents,
  entities,
  eq,
  facts,
  inArray,
  relationships,
} from "@grounded/db";
import dotenv from "dotenv";
import { processReconcileJob, pubRedis } from "./reconcile";

dotenv.config({ path: resolve(import.meta.dirname, "../../../../.env") });

const hasKey = Boolean(process.env.LLM_API_KEY || process.env.GEMINI_API_KEY);

let judgeCallCount = 0;

const makeUnitVector = (dim: number): number[] => {
  const vec = new Array(1536).fill(0);
  vec[dim % 1536] = 1;
  return vec;
};

// Similar inputs share a slot; dissimilar ones land far apart.
const slotFor = (text: string): number => {
  const lower = text.toLowerCase();
  if (lower.includes("revenue")) {
    return 10;
  }
  if (lower.includes("employee")) {
    return 30;
  }
  if (lower.includes("margin")) {
    return 50;
  }
  let hash = 0;
  for (let i = 0; i < lower.length; i++) {
    hash = (hash * 31 + lower.charCodeAt(i)) % 1536;
  }
  return Math.abs(hash) % 1536;
};

const mockEmbedFn = (texts: string[]): Promise<number[][]> =>
  Promise.resolve(texts.map((t) => makeUnitVector(1536, slotFor(t))));

const mockJudgeFn = (pair: {
  factA: { value: string; predicate: string };
  factB: { value: string; predicate: string };
}): Promise<{
  confidence: number;
  explanation: string;
  relationType: string;
}> => {
  judgeCallCount += 1;
  return Promise.resolve({
    confidence: 0.9,
    explanation: `Judge determined the relationship between ${pair.factA.value} and ${pair.factB.value} based on qualifiers and scope evidence.`,
    relationType: "contradicts",
  });
};

const insertFact = (
  documentId: string,
  overrides: Partial<typeof facts.$inferInsert> & {
    predicate: string;
    value: string;
  }
) =>
  db
    .insert(facts)
    .values({
      confidence: 0.95,
      documentId,
      embedding: makeUnitVector(
        1536,
        slotFor(`${overrides.predicate} ${overrides.value}`)
      ),
      entityId: null,
      rawValue: overrides.value,
      sourcePage: 1,
      sourceQuote: `Quote for ${overrides.value}`,
      ...overrides,
    })
    .returning();

describe("Phase-4 Matching & Reconciliation Integration Suite", () => {
  const createdDocIds: string[] = [];
  const createdEntityIds: string[] = [];

  const cleanup = async () => {
    if (createdDocIds.length > 0) {
      await db.delete(documents).where(inArray(documents.id, createdDocIds));
    }
    if (createdEntityIds.length > 0) {
      await db.delete(entities).where(inArray(entities.id, createdEntityIds));
    }
    createdDocIds.length = 0;
    createdEntityIds.length = 0;
  };

  beforeAll(async () => {
    await cleanup();
    judgeCallCount = 0;
  });

  afterAll(async () => {
    await cleanup();
    await pubRedis.quit().catch(() => {
      // Ignored: cleanup
    });
  });

  const makeDoc = async (filename: string): Promise<string> => {
    const [doc] = await db
      .insert(documents)
      .values({ filename, filePath: `/tmp/${filename}`, status: "resolved" })
      .returning();
    createdDocIds.push(doc.id);
    return doc.id;
  };

  test("I1: corroborates with textually different rawValues via rule layer (Exit Criterion 1)", async () => {
    const docA = await makeDoc("recon-doc-a.pdf");
    const docB = await makeDoc("recon-doc-b.pdf");

    const [factNew] = await insertFact(docA, {
      predicate: "annual_revenue",
      value: "$4.2M",
    });
    const [factExisting] = await insertFact(docB, {
      predicate: "annual_revenue",
      value: "4200000",
    });

    // Link both to the same entity so vector search scopes correctly
    const [entity] = await db
      .insert(entities)
      .values({ canonicalName: "Recon Test Entity" })
      .returning();
    createdEntityIds.push(entity.id);

    await db
      .update(facts)
      .set({ entityId: entity.id })
      .where(eq(facts.id, factNew.id));
    await db
      .update(facts)
      .set({ entityId: entity.id })
      .where(eq(facts.id, factExisting.id));

    const result = await processReconcileJob(
      { documentId: docA },
      {
        embedFn: mockEmbedFn,
        judgeFn: mockJudgeFn,
        matchDistance: 0.35,
      }
    );

    expect(result.success).toBe(true);
    expect(result.relationshipsCreated).toBeGreaterThanOrEqual(1);
    expect(result.ruleResolved).toBeGreaterThanOrEqual(1);
    expect(result.judgeCalls).toBe(0);

    const findRel = async (a: string, b: string) => {
      const [lo, hi] = [a, b].sort();
      const rows = await db
        .select()
        .from(relationships)
        .where(
          and(eq(relationships.factAId, lo), eq(relationships.factBId, hi))
        );
      return rows;
    };

    const all = await findRel(factNew.id, factExisting.id);
    expect(all.length).toBe(1);
    expect(all[0]?.relationType).toBe("corroborates");
    expect(all[0]?.method).toBe("rule");
    expect(all[0]?.explanation.length).toBeGreaterThan(0);
    // Exit criterion #1: rawValues differ textually but rule still corroborates
    expect(factNew.rawValue).not.toBe(factExisting.rawValue);
  });

  test("I2: contradicts via judge with confidence > 0.8 (Exit Criterion 2)", async () => {
    judgeCallCount = 0;
    const docA = await makeDoc("recon-contradict-a.pdf");
    const docB = await makeDoc("recon-contradict-b.pdf");

    const [entity] = await db
      .insert(entities)
      .values({ canonicalName: "Recon Contradict Entity" })
      .returning();
    createdEntityIds.push(entity.id);

    const [factNew] = await insertFact(docA, {
      predicate: "director_status",
      qualifiers: { board: "main" },
      timeScope: "FY2024",
      value: "500",
    });
    const [factExisting] = await insertFact(docB, {
      predicate: "director_status",
      qualifiers: { board: "main" },
      timeScope: "FY2024",
      value: "650",
    });

    await db
      .update(facts)
      .set({ entityId: entity.id })
      .where(eq(facts.id, factNew.id));
    await db
      .update(facts)
      .set({ entityId: entity.id })
      .where(eq(facts.id, factExisting.id));

    const result = await processReconcileJob(
      { documentId: docA },
      {
        embedFn: mockEmbedFn,
        judgeFn: mockJudgeFn,
        matchDistance: 0.35,
      }
    );

    expect(result.success).toBe(true);
    expect(result.judgeCalls).toBeGreaterThanOrEqual(1);

    const [lo, hi] = [factNew.id, factExisting.id].sort();
    const all = await db
      .select()
      .from(relationships)
      .where(and(eq(relationships.factAId, lo), eq(relationships.factBId, hi)));
    expect(all.length).toBe(1);
    expect(all[0]?.relationType).toBe("contradicts");
    expect(all[0]?.confidence).toBeGreaterThan(0.8);
    expect(all[0]?.method).toBe("llm_judge");
    expect(all[0]?.explanation.length).toBeGreaterThan(0);
  });

  test("I3: reconciled by differing timeScope names both scopes in explanation (Exit Criterion 3)", async () => {
    const docA = await makeDoc("recon-scope-a.pdf");
    const docB = await makeDoc("recon-scope-b.pdf");

    const [entity] = await db
      .insert(entities)
      .values({ canonicalName: "Recon Scope Entity" })
      .returning();
    createdEntityIds.push(entity.id);

    const [factNew] = await insertFact(docA, {
      predicate: "annual_revenue",
      timeScope: "FY2023",
      value: "$3.5M",
    });
    const [factExisting] = await insertFact(docB, {
      predicate: "annual_revenue",
      timeScope: "FY2024",
      value: "$4.2M",
    });

    await db
      .update(facts)
      .set({ entityId: entity.id })
      .where(eq(facts.id, factNew.id));
    await db
      .update(facts)
      .set({ entityId: entity.id })
      .where(eq(facts.id, factExisting.id));

    const result = await processReconcileJob(
      { documentId: docA },
      {
        embedFn: mockEmbedFn,
        judgeFn: mockJudgeFn,
        matchDistance: 0.35,
      }
    );

    expect(result.success).toBe(true);
    expect(result.ruleResolved).toBeGreaterThanOrEqual(1);

    const [lo, hi] = [factNew.id, factExisting.id].sort();
    const all = await db
      .select()
      .from(relationships)
      .where(and(eq(relationships.factAId, lo), eq(relationships.factBId, hi)));
    expect(all.length).toBe(1);
    expect(all[0]?.relationType).toBe("reconciled");
    expect(all[0]?.method).toBe("rule");
    expect(all[0]?.explanation).toContain("FY2023");
    expect(all[0]?.explanation).toContain("FY2024");
  });

  test("I4: every created relationship has non-empty explanation (Exit Criterion 4)", async () => {
    const docFacts = await db
      .select({ id: facts.id })
      .from(facts)
      .where(inArray(facts.documentId, createdDocIds));
    const factIdSet = new Set(docFacts.map((f) => f.id));

    const allRels = await db.select().from(relationships);
    const mine = allRels.filter(
      (r) => factIdSet.has(r.factAId) || factIdSet.has(r.factBId)
    );
    expect(mine.length).toBeGreaterThanOrEqual(3);
    for (const rel of mine) {
      expect(rel.explanation.trim().length).toBeGreaterThan(0);
    }
  });

  test("I5: idempotency — rerun creates zero net new relationships", async () => {
    const [docA] = createdDocIds;
    if (!docA) {
      throw new Error("No doc available");
    }
    const docFacts = await db
      .select({ id: facts.id })
      .from(facts)
      .where(eq(facts.documentId, docA));
    const factIdSet = new Set(docFacts.map((f) => f.id));

    const before = (await db.select().from(relationships)).filter(
      (r) => factIdSet.has(r.factAId) || factIdSet.has(r.factBId)
    );

    await processReconcileJob(
      { documentId: docA },
      {
        embedFn: mockEmbedFn,
        judgeFn: mockJudgeFn,
        matchDistance: 0.35,
      }
    );

    const after = (await db.select().from(relationships)).filter(
      (r) => factIdSet.has(r.factAId) || factIdSet.has(r.factBId)
    );
    expect(after.length).toBe(before.length);
  });

  test("I6: incremental — only the new document's facts are query sides", async () => {
    const [docA] = createdDocIds;
    if (!docA) {
      throw new Error("No doc available");
    }
    const docFacts = await db
      .select({ id: facts.id })
      .from(facts)
      .where(eq(facts.documentId, docA));

    let observedQuerySides = 0;
    const probeEmbedFn = (texts: string[]): Promise<number[][]> => {
      observedQuerySides += texts.length;
      return mockEmbedFn(texts);
    };

    await processReconcileJob(
      { documentId: docA },
      {
        embedFn: probeEmbedFn,
        judgeFn: mockJudgeFn,
        matchDistance: 0.35,
      }
    );

    const expected = docFacts.length;
    expect(observedQuerySides).toBe(expected);
  });

  test("I7: judge failure degrades to uncertain row, job continues", async () => {
    const docA = await makeDoc("recon-judge-fail-a.pdf");
    const docB = await makeDoc("recon-judge-fail-b.pdf");

    const [entity] = await db
      .insert(entities)
      .values({ canonicalName: "Recon Judge Fail Entity" })
      .returning();
    createdEntityIds.push(entity.id);

    const [factNew] = await insertFact(docA, {
      predicate: "employee_count",
      timeScope: "FY2024",
      value: "100",
    });
    const [factExisting] = await insertFact(docB, {
      predicate: "employee_count",
      timeScope: "FY2024",
      value: "200",
    });

    await db
      .update(facts)
      .set({ entityId: entity.id })
      .where(eq(facts.id, factNew.id));
    await db
      .update(facts)
      .set({ entityId: entity.id })
      .where(eq(facts.id, factExisting.id));

    const failingJudgeFn = (): Promise<{
      confidence: number;
      explanation: string;
      relationType: string;
    }> => Promise.reject(new Error("LLM gateway down"));

    const result = await processReconcileJob(
      { documentId: docA },
      {
        embedFn: mockEmbedFn,
        judgeFn: failingJudgeFn,
        matchDistance: 0.35,
      }
    );

    // Judge failure must degrade to an uncertain relationship, not fail the job
    expect(result.success).toBe(true);
    expect(result.judgeCalls).toBeGreaterThanOrEqual(1);

    const [lo, hi] = [factNew.id, factExisting.id].sort();
    const all = await db
      .select()
      .from(relationships)
      .where(and(eq(relationships.factAId, lo), eq(relationships.factBId, hi)));
    expect(all.length).toBe(1);
    expect(all[0]?.relationType).toBe("uncertain");
    expect(all[0]?.confidence).toBeLessThanOrEqual(0.4);
    expect(all[0]?.explanation).toContain("failed");
  });

  test("I8: facts with null entity or embedding are skipped and counted", async () => {
    const docA = await makeDoc("recon-skip-a.pdf");
    const docB = await makeDoc("recon-skip-b.pdf");

    const [entity] = await db
      .insert(entities)
      .values({ canonicalName: "Recon Skip Entity" })
      .returning();
    createdEntityIds.push(entity.id);

    // null embedding, HAS entity -> skippedNoEmbedding
    const [factNoEmbedding] = await insertFact(docA, {
      embedding: null,
      predicate: "margin_growth",
      value: "12%",
    });
    await db
      .update(facts)
      .set({ entityId: entity.id })
      .where(eq(facts.id, factNoEmbedding.id));
    // has embedding, null entity -> skippedNoEntity
    await insertFact(docA, {
      entityId: null,
      predicate: "margin_growth",
      value: "13%",
    });
    // valid pair candidate in other doc
    const [factExisting] = await insertFact(docB, {
      predicate: "margin_growth",
      value: "14%",
    });
    await db
      .update(facts)
      .set({ entityId: entity.id })
      .where(eq(facts.id, factExisting.id));

    const result = await processReconcileJob(
      { documentId: docA },
      {
        embedFn: mockEmbedFn,
        judgeFn: mockJudgeFn,
        matchDistance: 0.35,
      }
    );

    expect(result.success).toBe(true);
    expect(result.skippedNoEmbedding).toBe(1);
    expect(result.skippedNoEntity).toBe(1);
  });

  test("I9: status transitions reconciling -> done (and failed for missing doc)", async () => {
    const [docA] = createdDocIds;
    if (!docA) {
      throw new Error("No doc available");
    }
    const [doc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, docA));
    expect(doc.status).toBe("done");

    await expect(
      processReconcileJob({
        documentId: "00000000-0000-0000-0000-000000000000",
      })
    ).rejects.toThrow("not found in database");
  });

  test("I10: all-rule-resolvable fixture makes zero judge calls", async () => {
    const before = judgeCallCount;
    const docA = await makeDoc("recon-nojudge-a.pdf");
    const docB = await makeDoc("recon-nojudge-b.pdf");

    const [entity] = await db
      .insert(entities)
      .values({ canonicalName: "Recon NoJudge Entity" })
      .returning();
    createdEntityIds.push(entity.id);

    const [factNew] = await insertFact(docA, {
      predicate: "market_share",
      value: "25%",
    });
    const [factExisting] = await insertFact(docB, {
      predicate: "market_share",
      value: "25%",
    });

    await db
      .update(facts)
      .set({ entityId: entity.id })
      .where(eq(facts.id, factNew.id));
    await db
      .update(facts)
      .set({ entityId: entity.id })
      .where(eq(facts.id, factExisting.id));

    await processReconcileJob(
      { documentId: docA },
      {
        embedFn: mockEmbedFn,
        judgeFn: mockJudgeFn,
        matchDistance: 0.35,
      }
    );

    expect(judgeCallCount).toBe(before);
  });

  // Optional live judge test when keys are configured
  if (hasKey) {
    test("I11: live judge classifies an apparent contradiction (reconciled by timeScope)", async () => {
      const { judgeFactPair } = await import("../pipeline/llm");
      const result = await judgeFactPair(
        {
          factA: {
            id: "00000000-0000-0000-0000-0000000000a1",
            predicate: "annual_revenue",
            rawValue: "$3.5B",
            sourcePage: 3,
            sourceQuote:
              "Company reported annual revenue of $3.5B in fiscal 2023.",
            timeScope: "FY2023",
            value: "3500000000",
          },
          factB: {
            id: "00000000-0000-0000-0000-0000000000b2",
            predicate: "annual_revenue",
            rawValue: "$4.2B",
            sourcePage: 7,
            sourceQuote:
              "Company reported annual revenue of $4.2B in fiscal 2024.",
            timeScope: "FY2024",
            value: "4200000000",
          },
        },
        {
          docA: { filename: "annual-2023.pdf" },
          docB: { filename: "annual-2024.pdf" },
        }
      );

      expect(["reconciled", "uncertain"]).toContain(result.relationType);
      expect(result.explanation.length).toBeGreaterThan(0);
    }, 30_000);
  }
});
