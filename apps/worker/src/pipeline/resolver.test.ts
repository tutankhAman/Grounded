import { describe, expect, it } from "bun:test";
import {
  buildEntityConfirmPrompt,
  buildEntityEmbeddingInput,
  clusterSurfaceForms,
  cosineSimilarity,
  decideEntityMatch,
  electCanonical,
  normalizeForComparison,
  normalizeName,
  parseConfirmResponse,
  shouldMergeString,
  stringSimilarity,
} from "./resolver";

describe("resolver pure functions", () => {
  describe("normalizeName & normalizeForComparison", () => {
    it("strips outer quotes and whitespace", () => {
      expect(normalizeName('  "Acme Corp."  ')).toBe("Acme Corp.");
      expect(normalizeName("‘Acme Corp’")).toBe("Acme Corp");
    });

    it("normalizes corporate suffixes and leading 'the' for comparison", () => {
      expect(normalizeForComparison("The Acme Corporation")).toBe("acme corp");
      expect(normalizeForComparison("Acme Corp.")).toBe("acme corp");
      expect(normalizeForComparison("Acme Inc.")).toBe("acme inc");
      expect(normalizeForComparison("Acme Incorporated")).toBe("acme inc");
    });
  });

  describe("stringSimilarity", () => {
    it("returns 1.0 for identical strings (case-insensitive)", () => {
      expect(stringSimilarity("Acme Corp", "acme corp")).toBe(1.0);
    });

    it("returns >= 0.85 for minor punctuation differences", () => {
      const sim = stringSimilarity("Acme Corp", "Acme Corp.");
      expect(sim).toBeGreaterThanOrEqual(0.85);
    });

    it("returns low score for completely different names", () => {
      const sim = stringSimilarity("Acme Corp", "Wayne Enterprises");
      expect(sim).toBeLessThan(0.4);
    });
  });

  describe("shouldMergeString", () => {
    it("merges abbreviations and corporate variants", () => {
      expect(shouldMergeString("Acme Corp", "Acme Corp.")).toBe(true);
      expect(shouldMergeString("Acme Corp", "Acme Corporation")).toBe(true);
      expect(shouldMergeString("The Acme Corporation", "Acme Corp")).toBe(true);
    });

    it("does not merge different companies sharing a prefix word", () => {
      expect(shouldMergeString("Apple Inc.", "Apple Records")).toBe(false);
      expect(shouldMergeString("Google LLC", "Alphabet Inc.")).toBe(false);
    });
  });

  describe("buildEntityEmbeddingInput", () => {
    it("formats with canonical name and context", () => {
      expect(
        buildEntityEmbeddingInput(
          "Acme Corp",
          "Acme Corp is a supplier of anvils."
        )
      ).toBe("entity: Acme Corp | Acme Corp is a supplier of anvils.");
    });

    it("formats without context when context is omitted or empty", () => {
      expect(buildEntityEmbeddingInput("Acme Corp")).toBe("entity: Acme Corp");
      expect(buildEntityEmbeddingInput("Acme Corp", "   ")).toBe(
        "entity: Acme Corp"
      );
    });
  });

  describe("cosineSimilarity", () => {
    it("computes 1.0 for identical vectors", () => {
      expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1.0);
    });

    it("computes 0.0 for orthogonal vectors", () => {
      expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0.0);
    });

    it("computes -1.0 for opposite vectors", () => {
      expect(cosineSimilarity([1, 0], [-1, 0])).toBeCloseTo(-1.0);
    });

    it("handles empty or mismatched vectors safely", () => {
      expect(cosineSimilarity([], [])).toBe(0);
      expect(cosineSimilarity([1], [1, 2])).toBe(0);
    });
  });

  describe("decideEntityMatch", () => {
    it("defaults to 0.80 threshold", () => {
      expect(decideEntityMatch(0.85)).toBe(true);
      expect(decideEntityMatch(0.8)).toBe(true);
      expect(decideEntityMatch(0.79)).toBe(false);
    });

    it("respects custom threshold", () => {
      expect(decideEntityMatch(0.75, 0.7)).toBe(true);
      expect(decideEntityMatch(0.75, 0.9)).toBe(false);
    });
  });

  describe("electCanonical", () => {
    it("elects the most frequent surface form", () => {
      const mentions = [
        { factId: "1", name: "Acme Corp" },
        { factId: "2", name: "Acme Corporation" },
        { factId: "3", name: "Acme Corporation" },
      ];
      const result = electCanonical(mentions);
      expect(result.canonicalName).toBe("Acme Corporation");
    });

    it("breaks frequency ties by choosing the longest form", () => {
      const mentions = [
        { factId: "1", name: "Acme Corp" },
        { factId: "2", name: "Acme Corporation" },
      ];
      const result = electCanonical(mentions);
      expect(result.canonicalName).toBe("Acme Corporation");
    });

    it("breaks length ties by lexicographical order", () => {
      const mentions = [
        { factId: "1", name: "Beta" },
        { factId: "2", name: "Alfa" },
      ];
      const result = electCanonical(mentions);
      expect(result.canonicalName).toBe("Alfa");
    });

    it("elects the most frequent non-empty entityType", () => {
      const mentions = [
        { factId: "1", name: "Acme", type: "company" },
        { factId: "2", name: "Acme", type: "organization" },
        { factId: "3", name: "Acme", type: "organization" },
      ];
      const result = electCanonical(mentions);
      expect(result.entityType).toBe("organization");
    });

    it("selects the best context sample", () => {
      const mentions = [
        {
          context: "Short context.",
          factId: "1",
          name: "Acme Corp",
        },
        {
          context:
            "A comprehensive context sentence describing Acme Corporation in full detail.",
          factId: "2",
          name: "Acme Corporation",
        },
      ];
      const result = electCanonical(mentions);
      expect(result.contextSample).toBe(
        "A comprehensive context sentence describing Acme Corporation in full detail."
      );
    });
  });

  describe("parseConfirmResponse", () => {
    it("parses valid JSON response", () => {
      const raw = JSON.stringify({
        reasoning: "Both represent the same California technology company.",
        same: true,
      });
      const parsed = parseConfirmResponse(raw);
      expect(parsed.same).toBe(true);
      expect(parsed.reasoning).toContain("California technology company");
    });

    it("parses markdown JSON block", () => {
      const raw = `\`\`\`json
{
  "same": false,
  "reasoning": "Apple Records is a music label, not Apple Inc."
}
\`\`\``;
      const parsed = parseConfirmResponse(raw);
      expect(parsed.same).toBe(false);
      expect(parsed.reasoning).toContain("music label");
    });

    it("parses raw text starting with YES", () => {
      const parsed = parseConfirmResponse(
        "YES. Both refer to Acme Corporation, the manufacturing company."
      );
      expect(parsed.same).toBe(true);
      expect(parsed.reasoning).toContain("Acme Corporation");
    });

    it("parses raw text starting with NO", () => {
      const parsed = parseConfirmResponse(
        "NO. Apple Inc. is a hardware company while Apple Records is a record label."
      );
      expect(parsed.same).toBe(false);
      expect(parsed.reasoning).toContain("Apple Inc.");
    });

    it("correctly identifies YES when words containing 'no' like 'known' precede it", () => {
      const parsed = parseConfirmResponse(
        "These are well-known subsidiaries of the parent company. YES."
      );
      expect(parsed.same).toBe(true);
      expect(parsed.reasoning).toContain("well-known");
    });

    it("correctly identifies YES with prefix Answer:", () => {
      const parsed = parseConfirmResponse(
        "Answer: YES. Both refer to the same corporate entity."
      );
      expect(parsed.same).toBe(true);
    });

    it("correctly identifies NO with prefix Answer:", () => {
      const parsed = parseConfirmResponse(
        "Answer: NO. They are completely separate corporations."
      );
      expect(parsed.same).toBe(false);
    });
  });

  describe("buildEntityConfirmPrompt", () => {
    it("generates prompt matching spec format", () => {
      const prompt = buildEntityConfirmPrompt({
        contextA: "supplier of roadrunner traps",
        contextB: "industrial manufacturer",
        nameA: "Acme Corp",
        nameB: "Acme Corporation",
      });
      expect(prompt).toContain(
        "Are these two entities the same real-world entity?"
      );
      expect(prompt).toContain('Entity A: "Acme Corp"');
      expect(prompt).toContain('Entity B: "Acme Corporation"');
      expect(prompt).toContain(
        "Answer YES or NO with one sentence of reasoning."
      );
    });
  });

  describe("clusterSurfaceForms", () => {
    it("clusters string variations into one cluster and distinct names into another", () => {
      const mentions = [
        {
          context: "Acme Corp reported quarterly revenue.",
          factId: "fact-1",
          name: "Acme Corp",
          type: "organization",
        },
        {
          context: "Acme Corporation expanded into widgets.",
          factId: "fact-2",
          name: "Acme Corporation",
          type: "organization",
        },
        {
          context: "The Acme Corporation acquired an anvil factory.",
          factId: "fact-3",
          name: "The Acme Corporation",
          type: "organization",
        },
        {
          context: "Globex Corp is a competitor.",
          factId: "fact-4",
          name: "Globex Corp",
          type: "company",
        },
      ];

      const clusters = clusterSurfaceForms(mentions);
      expect(clusters.length).toBe(2);

      const acmeCluster = clusters.find((c) =>
        c.canonicalName.includes("Acme")
      );
      expect(acmeCluster).toBeDefined();
      expect(acmeCluster?.factIds).toHaveLength(3);
      expect(acmeCluster?.factIds).toContain("fact-1");
      expect(acmeCluster?.factIds).toContain("fact-2");
      expect(acmeCluster?.factIds).toContain("fact-3");
      expect(acmeCluster?.surfaceForms).toContain("Acme Corp");
      expect(acmeCluster?.surfaceForms).toContain("Acme Corporation");

      const globexCluster = clusters.find((c) =>
        c.canonicalName.includes("Globex")
      );
      expect(globexCluster).toBeDefined();
      expect(globexCluster?.factIds).toEqual(["fact-4"]);
    });

    it("merges alias via embedding similarity when provided", () => {
      const mentions = [
        {
          context: "Acme Corp headquarters.",
          factId: "fact-1",
          name: "Acme Corp",
        },
        {
          context: "The company announced new earnings.",
          factId: "fact-2",
          name: "the Company",
        },
      ];

      const embeddings = new Map<string, number[]>([
        ["acme corp", [0.8, 0.6, 0.0]],
        ["the company", [0.79, 0.61, 0.0]], // cosine ~ 0.999
      ]);

      const clusters = clusterSurfaceForms(mentions, { embeddings });
      expect(clusters.length).toBe(1);
      expect(clusters[0]?.factIds).toHaveLength(2);
    });
  });
});
