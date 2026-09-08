import { readdirSync } from "node:fs";
import { resolve } from "node:path";
import { db, documents, eq, pageChunks } from "@grounded/db";
import { processParseJob } from "../consumers/parse";
import { streamPages } from "../pipeline/parser";

interface SummaryStat {
  avgTokensPerPage: number;
  densePages: number[];
  filename: string;
  lowTextPages: number[];
  tableHeavyPages: number[];
  totalPages: number;
}

const findPdfs = (dir: string): string[] => {
  const entries = readdirSync(dir, { withFileTypes: true });
  const pdfs: string[] = [];
  for (const entry of entries) {
    const fullPath = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      pdfs.push(...findPdfs(fullPath));
    } else if (entry.name.endsWith(".pdf")) {
      pdfs.push(fullPath);
    }
  }
  return pdfs;
};

async function runTuning() {
  const datasetsDir = resolve(
    import.meta.dirname,
    "../../../../starter-datasets"
  );
  const pdfFiles = findPdfs(datasetsDir);

  console.log(
    `Found ${pdfFiles.length} starter PDFs for threshold analysis:\n`
  );

  const summaries: SummaryStat[] = [];

  for (const pdfPath of pdfFiles) {
    const filename = pdfPath.split("/").slice(-2).join("/");
    console.log(`Analyzing: ${filename}`);

    const tableHeavy: number[] = [];
    const lowText: number[] = [];
    const dense: number[] = [];
    let totalTokens = 0;
    let pageCount = 0;

    let maxHeapBytes = process.memoryUsage().heapUsed;

    for await (const page of streamPages(pdfPath)) {
      maxHeapBytes = Math.max(maxHeapBytes, process.memoryUsage().heapUsed);
      pageCount = page.totalPages;
      const c = page.chunks[0];
      totalTokens += c.tokenEstimate;

      if (c.isTableHeavy) {
        tableHeavy.push(page.pageNumber);
      } else if (c.isLowText) {
        lowText.push(page.pageNumber);
      } else {
        dense.push(page.pageNumber);
      }
    }

    summaries.push({
      avgTokensPerPage: Math.round(totalTokens / (pageCount || 1)),
      densePages: dense,
      filename,
      lowTextPages: lowText,
      tableHeavyPages: tableHeavy,
      totalPages: pageCount,
    });
  }

  console.log("\n--- Starter PDF Threshold Classification Summary ---");
  for (const s of summaries) {
    console.log(
      `\nDocument: ${s.filename} (${s.totalPages} pages, avg ${s.avgTokensPerPage} tokens/page)`
    );
    console.log(
      `  Table-heavy pages (${s.tableHeavyPages.length}): [${s.tableHeavyPages.slice(0, 8).join(", ")}${s.tableHeavyPages.length > 8 ? "..." : ""}]`
    );
    console.log(
      `  Low-text / title pages (${s.lowTextPages.length}): [${s.lowTextPages.slice(0, 8).join(", ")}${s.lowTextPages.length > 8 ? "..." : ""}]`
    );
    console.log(
      `  Dense text pages (${s.densePages.length}): [${s.densePages.slice(0, 8).join(", ")}${s.densePages.length > 8 ? "..." : ""}]`
    );
  }

  // End-to-end processing test on Delhivery Earnings Presentation (27 pages)
  const targetPdf =
    pdfFiles.find((p) =>
      p.includes("03-delhivery-q4-fy24-earnings-presentation")
    ) || pdfFiles[0];
  console.log(
    `\n--- Running End-to-End Ingestion on: ${targetPdf.split("/").pop()} ---`
  );

  let docId: string | null = null;
  try {
    const [doc] = await db
      .insert(documents)
      .values({
        filename: "e2e-test-presentation.pdf",
        filePath: targetPdf,
        status: "pending",
        uploadedAt: new Date(),
      })
      .returning();
    docId = doc.id;

    const startTime = performance.now();
    const initialMemory = process.memoryUsage().heapUsed;

    const result = await processParseJob({
      documentId: doc.id,
      filePath: targetPdf,
    });

    const durationMs = Math.round(performance.now() - startTime);
    const peakMemoryMb = Math.round(
      process.memoryUsage().heapUsed / 1024 / 1024
    );

    console.log(`\nProcessing completed in ${durationMs}ms`);
    console.log(
      `Heap Memory: ${peakMemoryMb}MB (initial: ${Math.round(initialMemory / 1024 / 1024)}MB)`
    );
    console.log(
      `Total Pages Parsed: ${result.totalPages}, Total Chunks Persisted: ${result.totalChunks}`
    );

    // Query database to verify persistence
    const [updatedDoc] = await db
      .select()
      .from(documents)
      .where(eq(documents.id, doc.id));
    console.log(
      `Document DB status: ${updatedDoc.status}, pageCount: ${updatedDoc.pageCount}`
    );

    const storedChunks = await db
      .select()
      .from(pageChunks)
      .where(eq(pageChunks.documentId, doc.id));

    console.log(`Stored page_chunks in DB: ${storedChunks.length}`);

    // Inspect first chunk position data
    const sampleChunk = storedChunks[0];
    const sampleRuns = (sampleChunk?.positionData as unknown[]) || [];
    console.log(`Sample Chunk 1 runs count: ${sampleRuns.length}`);
    if (sampleRuns.length > 0) {
      const firstRun = sampleRuns[0] as {
        height: number;
        text: string;
        width: number;
        x: number;
        y: number;
      };
      console.log(
        `Sample Run 1 coordinates: x=${firstRun.x}, y=${firstRun.y}, w=${firstRun.width}, h=${firstRun.height}, text="${firstRun.text}"`
      );
    }
  } finally {
    if (docId) {
      await db.delete(documents).where(eq(documents.id, docId));
      console.log(
        "\nCleaned up test document. Verification finished successfully."
      );
    }
  }
}

runTuning()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    console.error("Tuning script failed:", err);
    process.exit(1);
  });
