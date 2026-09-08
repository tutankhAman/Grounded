import { randomUUID } from "node:crypto";
import { mkdir, unlink } from "node:fs/promises";
import { basename, resolve } from "node:path";
import {
  asc,
  db,
  desc,
  documents,
  eq,
  facts,
  pageChunks,
  sql,
} from "@grounded/db";
import { Elysia, t } from "elysia";
import { addParseJob } from "../lib/queue";

const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR || "./uploads");
const LEADING_DOTS_REGEX = /^\.+/;
const UNSAFE_CHARS_REGEX = /[/\\?%*:|"<>]/g;

const sanitizeFilename = (filename: string): string => {
  // 1. Take basename FIRST to strip all path traversal directories
  const base = basename(filename);
  // 2. Remove any leading dots and unsafe characters
  const clean = base
    .replace(LEADING_DOTS_REGEX, "")
    .replace(UNSAFE_CHARS_REGEX, "_");
  return clean.length > 0 ? clean : "document.pdf";
};

export const documentRoutes = new Elysia({ prefix: "/documents" })
  .onError(({ code, set }) => {
    if (code === "VALIDATION") {
      set.status = 400;
      return { error: "Invalid file type. Only application/pdf is allowed." };
    }
  })
  .post(
    "/",
    async ({ body, set }) => {
      const { file } = body;

      // 1. Guard MIME type
      if (file?.type !== "application/pdf") {
        set.status = 400;
        return { error: "Invalid file type. Only application/pdf is allowed." };
      }

      // 2. Guard file size
      const maxMb = Number(process.env.MAX_UPLOAD_MB) || 100;
      const maxBytes = maxMb * 1024 * 1024;
      if (file.size > maxBytes) {
        set.status = 413;
        return {
          error: `File size exceeds maximum limit of ${maxMb}MB.`,
        };
      }

      // 3. Prepare storage
      const sanitizedName = sanitizeFilename(file.name);
      await mkdir(UPLOAD_DIR, { recursive: true });
      const targetFilename = `${randomUUID()}.pdf`;
      const targetPath = resolve(UPLOAD_DIR, targetFilename);

      // 4. Stream write with cleanup on failure
      try {
        await globalThis.Bun.write(targetPath, file.stream());
      } catch {
        try {
          await unlink(targetPath);
        } catch {
          // ignore cleanup failure if file wasn't created
        }
        set.status = 500;
        return { error: "Failed to write uploaded file to disk." };
      }

      // 5. Insert document record
      const [doc] = await db
        .insert(documents)
        .values({
          filename: sanitizedName,
          filePath: targetPath,
          status: "pending",
          uploadedAt: new Date(),
        })
        .returning();

      // 6. Enqueue parse job (fire-and-forget, never block response)
      await addParseJob({
        documentId: doc.id,
        filePath: targetPath,
      });

      set.status = 201;
      return {
        id: doc.id,
        filename: doc.filename,
        status: doc.status,
      };
    },
    {
      body: t.Object({
        file: t.File({ type: "application/pdf" }),
      }),
    }
  )
  .get("/", async () => {
    const list = await db
      .select()
      .from(documents)
      .orderBy(desc(documents.uploadedAt))
      .limit(50);
    return { data: list };
  })
  .get(
    "/:id",
    async ({ params: { id }, set }) => {
      const [doc] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, id))
        .limit(1);

      if (!doc) {
        set.status = 404;
        return { error: `Document ${id} not found` };
      }

      // Count chunks and facts
      const [chunkCountRes] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(pageChunks)
        .where(eq(pageChunks.documentId, id));

      const [factsCountRes] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(facts)
        .where(eq(facts.documentId, id));

      return {
        ...doc,
        counts: {
          chunks: chunkCountRes?.count ?? 0,
          facts: factsCountRes?.count ?? 0,
        },
      };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  )
  .get(
    "/:id/chunks",
    async ({ params: { id }, query, set }) => {
      const [doc] = await db
        .select({ id: documents.id })
        .from(documents)
        .where(eq(documents.id, id))
        .limit(1);

      if (!doc) {
        set.status = 404;
        return { error: `Document ${id} not found` };
      }

      const page = Math.max(1, Number(query.page) || 1);
      const limit = Math.max(1, Math.min(100, Number(query.limit) || 50));
      const offset = (page - 1) * limit;

      const [totalCountRes] = await db
        .select({ count: sql<number>`count(*)::int` })
        .from(pageChunks)
        .where(eq(pageChunks.documentId, id));

      const total = totalCountRes?.count ?? 0;

      const chunks = await db
        .select()
        .from(pageChunks)
        .where(eq(pageChunks.documentId, id))
        .orderBy(asc(pageChunks.pageNumber), asc(pageChunks.chunkIndex))
        .limit(limit)
        .offset(offset);

      return {
        data: chunks,
        pagination: {
          total,
          page,
          limit,
          totalPages: Math.ceil(total / limit),
        },
      };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
      query: t.Object({
        page: t.Optional(t.String()),
        limit: t.Optional(t.String()),
      }),
    }
  );
