import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { and, db, desc, documents, entities, eq, facts, pageChunks } from "@grounded/db";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../");
const DEFAULT_SAMPLE_FILE = resolve(REPO_ROOT, "spot-check/round1.sample.jsonl");
const DEFAULT_SUMMARY_FILE = resolve(REPO_ROOT, "spot-check/round1.summary.json");

export type SpotCheckVerdict =
  | "correct"
  | "quoteWrong"
  | "valueWrong"
  | "scopeWrong"
  | "unverified";

export interface SpotCheckRecord {
  chunkSnippet?: string | null;
  confidence: number;
  documentFilename: string;
  documentId: string;
  entityCanonicalName: string | null;
  factId: string;
  notes?: string;
  pageNumber: number;
  predicate: string;
  rawValue: string;
  sourceQuote: string;
  sourceQuoteValid: boolean | null;
  timeScope: string | null;
  unit: string | null;
  value: string;
  verdict: SpotCheckVerdict;
}

export interface SpotCheckSummary {
  counts: Record<SpotCheckVerdict, number>;
  precision: number;
  sampleSize: number;
  timestamp: string;
  verdictBreakdown: Record<string, string>;
}

export const sampleFacts = async (limit = 30): Promise<SpotCheckRecord[]> => {
  const rows = await db
    .select({
      confidence: facts.confidence,
      currency: facts.currency,
      documentFilename: documents.filename,
      documentId: facts.documentId,
      entityCanonicalName: entities.canonicalName,
      factId: facts.id,
      predicate: facts.predicate,
      rawValue: facts.rawValue,
      sourceChunkIndex: facts.sourceChunkIndex,
      sourcePage: facts.sourcePage,
      sourceQuote: facts.sourceQuote,
      sourceQuoteValid: facts.sourceQuoteValid,
      timeScope: facts.timeScope,
      unit: facts.unit,
      value: facts.value,
    })
    .from(facts)
    .leftJoin(documents, eq(facts.documentId, documents.id))
    .leftJoin(entities, eq(facts.entityId, entities.id))
    .orderBy(desc(facts.extractedAt))
    .limit(limit);

  const sample: SpotCheckRecord[] = [];

  for (const row of rows) {
    let chunkSnippet: string | null = null;
    let verdict: SpotCheckVerdict = "unverified";
    let notes = "";
    if (row.sourceChunkIndex !== null && row.sourcePage !== null) {
      const [chunk] = await db
        .select({ rawText: pageChunks.rawText })
        .from(pageChunks)
        .where(
          and(
            eq(pageChunks.documentId, row.documentId),
            eq(pageChunks.pageNumber, row.sourcePage),
            eq(pageChunks.chunkIndex, row.sourceChunkIndex)
          )
        )
        .limit(1);

      const fullText = chunk?.rawText ?? "";
      const quoteClean = row.sourceQuote.trim().toLowerCase();
      const rawValClean = row.rawValue.trim().toLowerCase();

      const quoteIndex = fullText.toLowerCase().indexOf(quoteClean);
      if (quoteIndex >= 0) {
        const start = Math.max(0, quoteIndex - 50);
        const end = Math.min(
          fullText.length,
          quoteIndex + quoteClean.length + 50
        );
        chunkSnippet = fullText.slice(start, end);
      } else if (fullText.length > 0) {
        chunkSnippet = fullText.slice(0, 200);
      }

      if (row.sourceQuoteValid === false) {
        verdict = "quoteWrong";
        notes = "Extractor flagged quote validation as false";
      } else if (fullText && quoteIndex < 0) {
        verdict = "quoteWrong";
        notes = "Quote text not found in source chunk text";
      } else if (
        !quoteClean.includes(rawValClean) &&
        !rawValClean.includes(quoteClean)
      ) {
        verdict = "valueWrong";
        notes = "Raw value not present in source quote";
      } else {
        verdict = "correct";
        notes = "Quote verified in chunk and raw value grounded in quote";
      }
    }

    sample.push({
      chunkSnippet,
      confidence: row.confidence,
      documentFilename: row.documentFilename ?? "unknown.pdf",
      documentId: row.documentId,
      entityCanonicalName: row.entityCanonicalName ?? null,
      factId: row.factId,
      notes,
      pageNumber: row.sourcePage,
      predicate: row.predicate,
      rawValue: row.rawValue,
      sourceQuote: row.sourceQuote,
      sourceQuoteValid: row.sourceQuoteValid,
      timeScope: row.timeScope,
      unit: row.unit,
      value: row.value,
      verdict,
    });
  }

  return sample;
};

export const scoreSample = (records: SpotCheckRecord[]): SpotCheckSummary => {
  const counts: Record<SpotCheckVerdict, number> = {
    correct: 0,
    quoteWrong: 0,
    scopeWrong: 0,
    unverified: 0,
    valueWrong: 0,
  };

  for (const rec of records) {
    if (rec.verdict in counts) {
      counts[rec.verdict]++;
    } else {
      counts.unverified++;
    }
  }

  const sampleSize = records.length;
  const precision = sampleSize > 0 ? Number((counts.correct / sampleSize).toFixed(4)) : 0;

  const verdictBreakdown: Record<string, string> = {};
  for (const [key, count] of Object.entries(counts)) {
    verdictBreakdown[key] =
      sampleSize > 0
        ? `${((count / sampleSize) * 100).toFixed(1)}%`
        : "0.0%";
  }

  return {
    counts,
    precision,
    sampleSize,
    timestamp: new Date().toISOString(),
    verdictBreakdown,
  };
};

const runCli = async (): Promise<void> => {
  const args = process.argv.slice(2);
  const command = args[0] ?? "all";

  if (command === "sample" || command === "all") {
    const sample = await sampleFacts(30);
    await mkdir(resolve(REPO_ROOT, "spot-check"), { recursive: true });
    const lines = sample.map((item) => JSON.stringify(item)).join("\n");
    await writeFile(DEFAULT_SAMPLE_FILE, `${lines}\n`, "utf8");
    console.log(`Sampled ${sample.length} facts to ${DEFAULT_SAMPLE_FILE}`);

    if (command === "all") {
      const summary = scoreSample(sample);
      await writeFile(
        DEFAULT_SUMMARY_FILE,
        JSON.stringify(summary, null, 2),
        "utf8"
      );
      console.log(`Scored summary written to ${DEFAULT_SUMMARY_FILE}`);
      console.table(summary.counts);
      console.log(`Precision: ${(summary.precision * 100).toFixed(2)}%`);
    }
  } else if (command === "score") {
    const raw = await readFile(DEFAULT_SAMPLE_FILE, "utf8");
    const records: SpotCheckRecord[] = raw
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l));

    const summary = scoreSample(records);
    await writeFile(
      DEFAULT_SUMMARY_FILE,
      JSON.stringify(summary, null, 2),
      "utf8"
    );
    console.log(`Scored summary written to ${DEFAULT_SUMMARY_FILE}`);
    console.table(summary.counts);
    console.log(`Precision: ${(summary.precision * 100).toFixed(2)}%`);
  } else {
    console.error(`Unknown command: ${command}. Use 'sample' or 'score'.`);
    process.exit(1);
  }
};

if (import.meta.main) {
  runCli()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error("Spot-check error:", err);
      process.exit(1);
    });
}
