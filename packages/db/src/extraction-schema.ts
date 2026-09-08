import { z } from "zod";

export const ExtractedFactSchema = z.object({
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence score from 0.0 to 1.0"),
  currency: z
    .string()
    .optional()
    .describe("ISO currency or symbol if applicable"),
  entity: z.object({
    context: z
      .string()
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
    .record(z.string())
    .optional()
    .describe("Any qualifiers that modify the fact meaning"),
  rawValue: z
    .string()
    .describe("Verbatim representation as stated in the text"),
  sourceQuote: z
    .string()
    .describe("Verbatim quote from the source chunk supporting this fact"),
  timeScope: z
    .string()
    .optional()
    .describe("Fiscal year, date, or period of validity"),
  unit: z.string().optional().describe("Measurement unit if applicable"),
  value: z.string().describe("Normalized value where possible"),
});

export const ExtractionResultSchema = z.object({
  facts: z.array(ExtractedFactSchema),
});

export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;

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
