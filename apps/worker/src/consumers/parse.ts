import { resolve } from "node:path";
import { db, documents, eq, type ParseJob, pageChunks } from "@grounded/db";
import dotenv from "dotenv";
import Redis from "ioredis";
import { streamPages } from "../pipeline/parser";

dotenv.config({ path: resolve(import.meta.dirname, "../../../../.env") });

const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
export const pubRedis = new Redis(redisUrl, {
  lazyConnect: true,
  maxRetriesPerRequest: null,
});

export interface ParseResult {
  documentId: string;
  totalChunks: number;
  totalPages: number;
}

export const processParseJob = async (
  jobData: ParseJob
): Promise<ParseResult> => {
  const { documentId, filePath } = jobData;

  // 1. Transition status to 'parsing'
  await db
    .update(documents)
    .set({
      errorMessage: null,
      status: "parsing",
    })
    .where(eq(documents.id, documentId));

  // Connect pub redis if needed
  if (pubRedis.status === "wait") {
    await pubRedis.connect().catch((_err) => {
      // Ignored: pub/sub delivery is best-effort
    });
  }

  let finalTotalPages = 0;
  let totalChunks = 0;

  try {
    // 2. Stream pages lazily with O(1-page) memory
    for await (const pageResult of streamPages(documentId, filePath)) {
      const { totalPages, chunks, pageNumber } = pageResult;
      finalTotalPages = totalPages;

      try {
        // 3. Upsert page_chunks concurrently per page
        await Promise.all(
          chunks.map((chunk) =>
            db
              .insert(pageChunks)
              .values({
                chunkIndex: chunk.chunkIndex,
                createdAt: new Date(),
                documentId,
                imagePath: null, // As verified in Step 0, rendering deferred
                isLowText: chunk.isLowText,
                isTableHeavy: chunk.isTableHeavy,
                needsVision: chunk.isTableHeavy || chunk.isLowText,
                pageNumber: chunk.pageNumber,
                positionData: chunk.runs,
                rawText: chunk.rawText,
                tokenEstimate: chunk.tokenEstimate,
              })
              .onConflictDoUpdate({
                set: {
                  isLowText: chunk.isLowText,
                  isTableHeavy: chunk.isTableHeavy,
                  needsVision: chunk.isTableHeavy || chunk.isLowText,
                  positionData: chunk.runs,
                  rawText: chunk.rawText,
                  tokenEstimate: chunk.tokenEstimate,
                },
                target: [
                  pageChunks.documentId,
                  pageChunks.pageNumber,
                  pageChunks.chunkIndex,
                ],
              })
          )
        );

        totalChunks += chunks.length;

        // 4. Fire-and-forget progress message (never await delivery)
        pubRedis
          .publish(
            `doc:${documentId}:status`,
            JSON.stringify({
              progress: {
                current: pageNumber,
                total: totalPages,
              },
              status: "parsing",
            })
          )
          .catch((_err) => {
            // Ignored: fire-and-forget
          });
      } catch (pageErr: unknown) {
        const message =
          pageErr instanceof Error ? pageErr.message : String(pageErr);
        // Log warning and continue processing remaining pages
        console.warn(
          `[Warning] Failed to persist page ${pageNumber} for doc ${documentId}: ${message}`
        );
      }
    }

    // 5. Update document to 'parsed' with verified pageCount
    await db
      .update(documents)
      .set({
        errorMessage: null,
        pageCount: finalTotalPages,
        status: "parsed",
      })
      .where(eq(documents.id, documentId));

    // Notify completion
    pubRedis
      .publish(
        `doc:${documentId}:status`,
        JSON.stringify({
          progress: {
            current: finalTotalPages,
            total: finalTotalPages,
          },
          status: "parsed",
        })
      )
      .catch((_err) => {
        // Ignored: fire-and-forget
      });

    return {
      documentId,
      totalChunks,
      totalPages: finalTotalPages,
    };
  } catch (fatalErr: unknown) {
    const errorMessage =
      fatalErr instanceof Error
        ? fatalErr.message
        : "Unknown fatal parsing error";

    await db
      .update(documents)
      .set({
        errorMessage,
        status: "failed",
      })
      .where(eq(documents.id, documentId));

    pubRedis
      .publish(
        `doc:${documentId}:status`,
        JSON.stringify({
          error: errorMessage,
          status: "failed",
        })
      )
      .catch((_err) => {
        // Ignored: fire-and-forget
      });

    throw fatalErr;
  }
};
