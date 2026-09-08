import { resolve } from "node:path";
import { db, documents, eq, facts, sql } from "@grounded/db";
import dotenv from "dotenv";
import { processExtractJob } from "../consumers/extract";
import { processParseJob } from "../consumers/parse";
import { processReconcileJob } from "../consumers/reconcile";
import { processResolveJob } from "../consumers/resolve";

dotenv.config({ path: resolve(import.meta.dirname, "../../../../.env") });

const statusOf = async (id: string) => {
  const [d] = await db
    .select({ status: documents.status })
    .from(documents)
    .where(eq(documents.id, id));
  return d?.status;
};

const [doc] = await db
  .select()
  .from(documents)
  .where(sql`${documents.filename} ILIKE '%03-delhivery-q4%'`)
  .limit(1);

if (!doc) {
  throw new Error("03 deck document not found in DB");
}
if (!doc.filePath) {
  throw new Error("03 deck document has no filePath");
}

console.log(
  `[Pilot] doc=${doc.id} status=${doc.status} pages=${doc.pageCount} file=${doc.filePath}`
);
const t0 = Date.now();
const pr = await processParseJob({
  documentId: doc.id,
  filePath: doc.filePath,
});
const tParse = Date.now();
console.log(
  `[Pilot] parse=${tParse - t0}ms pages=${pr.totalPages} chunks=${pr.totalChunks} status=${await statusOf(doc.id)}`
);
const ex = await processExtractJob({ documentId: doc.id });
const tEx = Date.now();
console.log(
  `[Pilot] extract=${tEx - tParse}ms facts=${ex.factsExtracted} failed=${ex.chunksFailed} status=${await statusOf(doc.id)}`
);
const rs = await processResolveJob({ documentId: doc.id });
const tRs = Date.now();
console.log(
  `[Pilot] resolve=${tRs - tEx}ms entities=${rs.entitiesResolved} linked=${rs.factsLinked} status=${await statusOf(doc.id)}`
);
const rc = await processReconcileJob({ documentId: doc.id });
const tRc = Date.now();
const [{ n }] = await db
  .select({ n: sql<number>`count(*)::int` })
  .from(facts)
  .where(eq(facts.documentId, doc.id));

console.log(
  `[Pilot] reconcile=${tRc - tRs}ms pairs=${rc.pairsEvaluated} created=${rc.relationshipsCreated} status=${await statusOf(doc.id)}`
);
console.log(
  `[Pilot] TOTAL=${tRc - t0}ms dbFacts=${n}`
);
await process.exit(0);
