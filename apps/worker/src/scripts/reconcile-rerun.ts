import { resolve } from "node:path";
import { db, documents } from "@grounded/db";
import dotenv from "dotenv";
import { processReconcileJob } from "../consumers/reconcile";

dotenv.config({ path: resolve(import.meta.dirname, "../../../../.env") });

// Re-runs reconciliation for every completed document so pairs previously
// stamped `uncertain` by the broken judge path get genuinely re-judged.
// Safe: existing pairs are skipped via existingPairKeys + unique index.
const docs = await db
  .select({ id: documents.id, filename: documents.filename })
  .from(documents);

for (const doc of docs) {
  console.log(`[ReconcileRerun] ${doc.filename} (${doc.id})`);
  const result = await processReconcileJob({ documentId: doc.id });
  console.log(
    `[ReconcileRerun] done: pairs=${result.pairsEvaluated} ` +
      `rule=${result.ruleResolved} judge=${result.judgeCalls} ` +
      `created=${result.relationshipsCreated}`
  );
}
await process.exit(0);
