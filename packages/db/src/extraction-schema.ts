import { z } from "zod";

export const ExtractedFactSchema = z.object({
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence score from 0.0 to 1.0"),
  currency: z
    .string()
    .nullish()
    .describe("ISO currency or symbol if applicable, or null"),
  entity: z.object({
    context: z
      .union([
        z.string(),
        z.record(z.string(), z.unknown()),
        z.array(z.unknown()),
      ])
      .transform((c) => (typeof c === "string" ? c : JSON.stringify(c)))
      .describe(
        "One sentence of surrounding context making the entity unambiguous"
      ),
    name: z.string().describe("The name of the entity, e.g. Acme Corp"),
    type: z
      .string()
      .describe("Inferred type e.g. organization, person, place, product"),
  }),
  factTypeDescription: z
    .string()
    .describe("One-sentence general description of this category of fact"),
  predicate: z
    .string()
    .describe("snake_case identifier for the property/attribute"),
  qualifiers: z
    .union([
      z.record(z.string(), z.unknown()),
      z.array(z.object({ key: z.string(), value: z.unknown() })),
    ])
    .nullish()
    .transform((val): Record<string, unknown> => {
      if (!val) {
        return {};
      }
      if (Array.isArray(val)) {
        const rec: Record<string, unknown> = {};
        for (const item of val) {
          if (item && typeof item === "object" && "key" in item) {
            rec[item.key] = item.value;
          }
        }
        return rec;
      }
      return val;
    })
    .describe("Key-value qualifiers that modify the fact meaning"),
  rawValue: z
    .string()
    .describe("Verbatim representation as stated in the text"),
  sourceQuote: z
    .string()
    .describe("Verbatim quote from the source chunk supporting this fact"),
  timeScope: z
    .string()
    .nullish()
    .describe("Fiscal year, date, or period of validity, or null"),
  unit: z
    .string()
    .nullish()
    .describe("Measurement unit if applicable, or null"),
  value: z.coerce.string().describe("Normalized value where possible"),
});

export const ExtractionResultSchema = z.object({
  facts: z.array(ExtractedFactSchema),
});

export const BatchExtractedFactSchema = ExtractedFactSchema.extend({
  pageNumber: z.coerce
    .number()
    .int()
    .min(1)
    .describe("1-based page number where this fact appears"),
});

export const BatchExtractionResultSchema = z.object({
  facts: z.array(BatchExtractedFactSchema),
});

export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
export type BatchExtractedFact = z.infer<typeof BatchExtractedFactSchema>;
export type BatchExtractionResult = z.infer<typeof BatchExtractionResultSchema>;

export const ReconciliationResultSchema = z.object({
  confidence: z.number().min(0).max(1),
  explanation: z
    .string()
    .describe(
      "Plain-language natural reasoning trace explaining the relationship"
    ),
  relationType: z.enum([
    "corroborates",
    "contradicts",
    "reconciled",
    "uncertain",
  ]),
});

export type ReconciliationResult = z.infer<typeof ReconciliationResultSchema>;

export const EntityConfirmSchema = z.object({
  reasoning: z
    .string()
    .min(1)
    .describe(
      "One sentence of reasoning explaining why they are or are not the same entity"
    ),
  same: z
    .boolean()
    .describe(
      "Whether Entity A and Entity B refer to the same real-world entity"
    ),
});

export type EntityConfirm = z.infer<typeof EntityConfirmSchema>;
