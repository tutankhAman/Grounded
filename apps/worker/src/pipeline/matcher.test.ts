import { describe, expect, it } from "bun:test";
import {
  compareQualifiers,
  compareTimeScope,
  normalizeTimeScope,
  normalizeValue,
  parseNumeric,
  ruleReconcile,
} from "./matcher";
import {
  buildJudgePrompt,
  canonicalizePair,
  isCandidatePredicateMatch,
  parseJudgeResponse,
} from "./reconciler";

describe("Phase-4 Matcher & Reconciler Pure Unit Tests", () => {
  describe("U1: normalizeValue", () => {
    it("normalizes whitespace, casing, outer quotes, and commas", () => {
      expect(normalizeValue('  "1,000,000"  ')).toBe("1000000");
      expect(normalizeValue("$4,200.50")).toBe("$4200.50");
      expect(normalizeValue("  Acme   Corporation  ")).toBe("acme corporation");
    });

    it("normalizes percent, pct, and basis points", () => {
      expect(normalizeValue("15 percent")).toBe("15%");
      expect(normalizeValue("15 pct")).toBe("15%");
      expect(normalizeValue("50 bps")).toBe("0.5%");
      expect(normalizeValue("150 basis points")).toBe("1.5%");
    });
  });

  describe("U2: parseNumeric and unit table", () => {
    it("parses multipliers K, M, B, Cr, L", () => {
      const k = parseNumeric("50K");
      expect(k?.value).toBe(50_000);

      const m = parseNumeric("$4.2M");
      expect(m?.value).toBe(4_200_000);
      expect(m?.currency).toBe("USD");

      const b = parseNumeric("2.5 billion");
      expect(b?.value).toBe(2_500_000_000);

      const cr = parseNumeric("10 Cr", "crores");
      expect(cr?.value).toBe(100_000_000);

      const l = parseNumeric("5 Lakh", "lakhs");
      expect(l?.value).toBe(500_000);
    });

    it("parses currencies $, ₹, €, £, and text codes", () => {
      expect(parseNumeric("$100")?.currency).toBe("USD");
      expect(parseNumeric("₹500")?.currency).toBe("INR");
      expect(parseNumeric("€250")?.currency).toBe("EUR");
      expect(parseNumeric("£1000")?.currency).toBe("GBP");
      expect(parseNumeric("500 USD", undefined, "USD")?.currency).toBe("USD");
    });

    it("returns null for unparseable or unknown unit without throwing", () => {
      expect(parseNumeric("N/A")).toBeNull();
      expect(parseNumeric("-")).toBeNull();
      expect(parseNumeric("None")).toBeNull();
      expect(parseNumeric("Not available")).toBeNull();
    });
  });

  describe("U3: Exact match -> corroborates/rule/0.95", () => {
    it("corroborates identical raw values with non-empty explanation", () => {
      const factA = {
        id: "f1",
        predicate: "revenue",
        value: "$4,200,000",
      };
      const factB = {
        id: "f2",
        predicate: "revenue",
        value: "$4200000",
      };

      const res = ruleReconcile(factA, factB);
      expect(res.escalate).toBe(false);
      if (!res.escalate) {
        expect(res.decision.relationType).toBe("corroborates");
        expect(res.decision.confidence).toBe(0.95);
        expect(res.decision.method).toBe("rule");
        expect(res.decision.explanation.length).toBeGreaterThan(0);
        expect(res.decision.explanation).toContain("$4,200,000");
      }
    });
  });

  describe("U4: Unit-convertible equality & currency differences", () => {
    it("corroborates $4.2M vs 4200000 as numerically equal", () => {
      const factA = {
        id: "f1",
        predicate: "revenue",
        value: "$4.2M",
      };
      const factB = {
        id: "f2",
        predicate: "revenue",
        value: "4200000",
      };

      const res = ruleReconcile(factA, factB);
      expect(res.escalate).toBe(false);
      if (!res.escalate) {
        expect(res.decision.relationType).toBe("corroborates");
        expect(res.decision.confidence).toBe(0.95);
        expect(res.decision.method).toBe("rule");
        expect(res.decision.explanation).toContain("numerically equivalent");
      }
    });

    it("reconciles same numeric amount with differing currencies naming currency difference", () => {
      const factA = {
        currency: "USD",
        id: "f1",
        predicate: "operating cost",
        value: "$100M",
      };
      const factB = {
        currency: "EUR",
        id: "f2",
        predicate: "operating cost",
        value: "€100M",
      };

      const res = ruleReconcile(factA, factB);
      expect(res.escalate).toBe(false);
      if (!res.escalate) {
        expect(res.decision.relationType).toBe("reconciled");
        expect(res.decision.method).toBe("rule");
        expect(res.decision.explanation).toContain("USD");
        expect(res.decision.explanation).toContain("EUR");
      }
    });

    it("does NOT corroborate a percentage against an absolute value ($50 vs 50%)", () => {
      const factA = {
        id: "f1",
        predicate: "profit_margin",
        value: "$50",
      };
      const factB = {
        id: "f2",
        predicate: "profit_margin",
        value: "50%",
      };

      const res = ruleReconcile(factA, factB);
      // These are categorically different (currency-denominated absolute vs a
      // percentage); the rule layer must escalate, never emit a corroboration.
      expect(res.escalate).toBe(true);
    });
  });

  describe("U5: TimeScope normalization and comparison", () => {
    it("normalizes FY24, FY2024, and 2023-24 to equivalent scope", () => {
      expect(normalizeTimeScope("FY24")).toBe("FY2024");
      expect(normalizeTimeScope("FY 2024")).toBe("FY2024");
      expect(normalizeTimeScope("Fiscal 2024")).toBe("FY2024");
      expect(normalizeTimeScope("2023-24")).toBe("FY2024");
      expect(normalizeTimeScope("2023-2024")).toBe("FY2024");

      const comp = compareTimeScope("FY24", "2023-24");
      expect(comp.sameScope).toBe(true);
    });

    it("normalizes FY-prefixed 2-digit ranges to the ending fiscal year (FY23-24 -> FY2024)", () => {
      expect(normalizeTimeScope("FY23-24")).toBe("FY2024");
      expect(normalizeTimeScope("2023-24")).toBe("FY2024");

      const comp = compareTimeScope("FY23-24", "2023-24");
      expect(comp.sameScope).toBe(true);
    });

    it("reconciles differing timeScopes with differing values naming both scopes", () => {
      const factA = {
        id: "f1",
        predicate: "revenue",
        timeScope: "FY2023",
        value: "$3.5M",
      };
      const factB = {
        id: "f2",
        predicate: "revenue",
        timeScope: "FY2024",
        value: "$4.2M",
      };

      const res = ruleReconcile(factA, factB);
      expect(res.escalate).toBe(false);
      if (!res.escalate) {
        expect(res.decision.relationType).toBe("reconciled");
        expect(res.decision.explanation).toContain("FY2023");
        expect(res.decision.explanation).toContain("FY2024");
      }
    });
  });

  describe("U6 & U7: Scope escalation cases", () => {
    it("escalates when values differ under matching timeScope and no qualifier delta", () => {
      const factA = {
        id: "f1",
        predicate: "employee count",
        timeScope: "FY2024",
        value: "500",
      };
      const factB = {
        id: "f2",
        predicate: "employee count",
        timeScope: "FY2024",
        value: "650",
      };

      const res = ruleReconcile(factA, factB);
      expect(res.escalate).toBe(true);
      if (res.escalate) {
        expect(res.reason).toContain("requires LLM judge");
      }
    });

    it("escalates when timeScope is missing on either side", () => {
      const factA = {
        id: "f1",
        predicate: "net margin",
        timeScope: "FY2024",
        value: "15%",
      };
      const factB = {
        id: "f2",
        predicate: "net margin",
        timeScope: null,
        value: "20%",
      };

      const res = ruleReconcile(factA, factB);
      expect(res.escalate).toBe(true);
      if (res.escalate) {
        expect(res.reason).toContain("Missing time scope");
      }
    });
  });

  describe("U8: Qualifier delta", () => {
    it("reconciles differing qualifier naming the key", () => {
      const factA = {
        id: "f1",
        predicate: "revenue",
        qualifiers: { geography: "North America" },
        timeScope: "FY2024",
        value: "$2.0M",
      };
      const factB = {
        id: "f2",
        predicate: "revenue",
        qualifiers: { geography: "Europe" },
        timeScope: "FY2024",
        value: "$1.5M",
      };

      const res = ruleReconcile(factA, factB);
      expect(res.escalate).toBe(false);
      if (!res.escalate) {
        expect(res.decision.relationType).toBe("reconciled");
        expect(res.decision.explanation).toContain("geography");
        expect(res.decision.explanation).toContain("North America");
        expect(res.decision.explanation).toContain("Europe");
      }
    });

    it("ignores system qualifiers like printedPage or _entity", () => {
      const qualA = {
        _entity: { name: "Acme" },
        printedPage: 5,
        region: "APAC",
      };
      const qualB = {
        _entity: { name: "Acme" },
        printedPage: 22,
        region: "APAC",
      };

      const comp = compareQualifiers(qualA, qualB);
      expect(comp.identical).toBe(true);
      expect(comp.differingKeys.length).toBe(0);
    });
  });

  describe("U9: Garbage numerics -> escalate", () => {
    it("escalates on unparseable values without throwing", () => {
      const factA = {
        id: "f1",
        predicate: "status",
        value: "Pending Approval",
      };
      const factB = {
        id: "f2",
        predicate: "status",
        value: "Rejected by Board",
      };

      const res = ruleReconcile(factA, factB);
      expect(res.escalate).toBe(true);
      if (res.escalate) {
        expect(res.reason).toContain("LLM judge");
      }
    });
  });

  describe("U10: Judge prompt and response parsing", () => {
    it("builds judge prompt including quotes, filename, and page numbers", () => {
      const prompt = buildJudgePrompt({
        docA: { filename: "report-2023.pdf" },
        docB: { filename: "report-2024.pdf" },
        factA: {
          id: "f1",
          predicate: "revenue",
          rawValue: "$4.2M",
          sourcePage: 3,
          sourceQuote: "Total revenue reached $4.2M in fiscal 2023.",
          value: "$4.2M",
        },
        factB: {
          id: "f2",
          predicate: "revenue",
          rawValue: "$5.1M",
          sourcePage: 12,
          sourceQuote: "Total revenue increased to $5.1M in fiscal 2024.",
          value: "$5.1M",
        },
      });

      expect(prompt).toContain(
        'Source A: "Total revenue reached $4.2M in fiscal 2023." (report-2023.pdf, page 3)'
      );
      expect(prompt).toContain(
        'Source B: "Total revenue increased to $5.1M in fiscal 2024." (report-2024.pdf, page 12)'
      );
      expect(prompt).toContain("Classify the relationship and explain it");
    });

    it("parses valid JSON response", () => {
      const json = JSON.stringify({
        confidence: 0.92,
        explanation:
          "Fact B reports higher revenue due to organic growth in FY2024.",
        relationType: "reconciled",
      });
      const parsed = parseJudgeResponse(json);
      expect(parsed.relationType).toBe("reconciled");
      expect(parsed.confidence).toBe(0.92);
      expect(parsed.explanation).toContain("organic growth");
    });

    it("parses markdown JSON block response", () => {
      const md = `Here is the evaluation:
\`\`\`json
{
  "relationType": "contradicts",
  "confidence": 0.85,
  "explanation": "Both documents describe identical scope but disagree on figures."
}
\`\`\``;
      const parsed = parseJudgeResponse(md);
      expect(parsed.relationType).toBe("contradicts");
      expect(parsed.confidence).toBe(0.85);
    });

    it("returns uncertain with failure explanation on unparseable garbage", () => {
      const parsed = parseJudgeResponse(
        "I am sorry, but as an AI I cannot determine this."
      );
      expect(parsed.relationType).toBe("uncertain");
      expect(parsed.confidence).toBeLessThanOrEqual(0.4);
      expect(parsed.explanation).toContain("unstructured or unparseable");
    });
  });

  describe("U11: Pair canonicalization & predicate filter", () => {
    it("canonicalizes pair order deterministically", () => {
      const fact1 = { id: "00000000-0000-0000-0000-000000000001" };
      const fact2 = { id: "00000000-0000-0000-0000-000000000002" };

      const order1 = canonicalizePair(fact1, fact2);
      expect(order1.factAId).toBe(fact1.id);
      expect(order1.factBId).toBe(fact2.id);
      expect(order1.reversed).toBe(false);

      const order2 = canonicalizePair(fact2, fact1);
      expect(order2.factAId).toBe(fact1.id);
      expect(order2.factBId).toBe(fact2.id);
      expect(order2.reversed).toBe(true);
    });

    it("throws when attempting to pair fact with itself", () => {
      const fact = { id: "00000000-0000-0000-0000-000000000001" };
      expect(() => canonicalizePair(fact, fact)).toThrow("Cannot pair fact");
    });

    it("checks candidate predicate matching", () => {
      expect(isCandidatePredicateMatch("total revenue", "Total Revenue")).toBe(
        true
      );
      expect(isCandidatePredicateMatch("revenue", "net revenue")).toBe(true);
      expect(
        isCandidatePredicateMatch("revenue", "director of operations")
      ).toBe(false);
      expect(isCandidatePredicateMatch("foo", "bar", "type-1", "type-1")).toBe(
        true
      );
    });
  });
});
