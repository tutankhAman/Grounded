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
      .union([z.string(), z.record(z.unknown()), z.array(z.unknown())])
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
    .array(
      z.object({
        key: z.string(),
        value: z.string(),
      })
    )
    .nullish()
    .describe("Any key-value qualifiers that modify the fact meaning, or null"),
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
