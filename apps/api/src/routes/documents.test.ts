import { afterAll, describe, expect, mock, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { db, documents, eq, sql } from "@grounded/db";

mock.module("../lib/queue", () => ({
  addParseJob: mock(async () => "mock-job-id"),
  closeQueue: mock(async () => {
    // No-op queue close in unit tests
  }),
}));

// Import app pure after queue mock is registered
import { app } from "../index";

// Gate database tests if Postgres is not reachable
let dbAvailable = false;
try {
  await db.execute(sql`SELECT 1`);
  dbAvailable = true;
} catch {
  console.warn("⚠️ Skipping document route tests: Postgres is not reachable.");
  dbAvailable = false;
}

// Minimal valid single-page PDF fixture
const MINIMAL_VALID_PDF =
  "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 1/Kids[3 0 R]>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R>>endobj\nxref\n0 4\n0000000000 65535 f \n0000000010 00000 n \n0000000060 00000 n \n0000000117 00000 n \ntrailer<</Size 4/Root 1 0 R>>\nstartxref\n190\n%%EOF";

describe.skipIf(!dbAvailable)("POST /documents API tests", () => {
  const createdDocIds: string[] = [];

  afterAll(async () => {
    // Clean up created test documents from db and disk
    for (const id of createdDocIds) {
      const [doc] = await db
        .select()
        .from(documents)
        .where(eq(documents.id, id));
      if (doc?.filePath && existsSync(doc.filePath)) {
        try {
          unlinkSync(doc.filePath);
        } catch {
          // Ignored cleanup error
        }
      }
      await db.delete(documents).where(eq(documents.id, id));
    }
  });

  test("rejects non-PDF files with 400 Bad Request", async () => {
    const textBlob = new Blob(["Not a PDF file content"], {
      type: "text/plain",
    });
    const formData = new FormData();
    formData.append("file", textBlob, "test.txt");

    const res = await app.handle(
      new Request("http://localhost:3000/documents", {
        method: "POST",
        body: formData,
      })
    );

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Only application/pdf is allowed");
  });

  test("rejects oversized files with 413 Payload Too Large", async () => {
    const originalLimit = process.env.MAX_UPLOAD_MB;
    process.env.MAX_UPLOAD_MB = "0.0001"; // ~104 bytes limit
    try {
      const dummyBlob = new Blob([`%PDF-1.4 ${"A".repeat(500)}`], {
        type: "application/pdf",
      });
      const formData = new FormData();
      formData.append("file", dummyBlob, "large.pdf");

      const res = await app.handle(
        new Request("http://localhost:3000/documents", {
          method: "POST",
          body: formData,
        })
      );

      expect(res.status).toBe(413);
      const body = (await res.json()) as { error?: string };
      expect(body.error).toContain("exceeds maximum limit");
    } finally {
      if (originalLimit === undefined) {
        delete process.env.MAX_UPLOAD_MB;
      } else {
        process.env.MAX_UPLOAD_MB = originalLimit;
      }
    }
  });

  test("sanitizes traversal filename, writes file, and omits internal filePath from responses", async () => {
    const pdfBlob = new Blob([MINIMAL_VALID_PDF], {
      type: "application/pdf",
    });
    const formData = new FormData();
    formData.append("file", pdfBlob, "../../../../etc/secret_report.pdf");

    const res = await app.handle(
      new Request("http://localhost:3000/documents", {
        method: "POST",
        body: formData,
      })
    );

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      id: string;
      filename: string;
      status: string;
    };
    expect(body.id).toBeDefined();
    expect(body.status).toBe("pending");
    expect(body.filename).toBe("secret_report.pdf"); // Traversal stripped!
    expect(body.filename).not.toContain("..");

    createdDocIds.push(body.id);

    // Verify debug GET /documents/:id endpoint returns 200 with counts and no filePath leak
    const getRes = await app.handle(
      new Request(`http://localhost:3000/documents/${body.id}`, {
        method: "GET",
      })
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      counts: { chunks: number };
      filePath?: string;
      id: string;
    };
    expect(getBody.id).toBe(body.id);
    expect(getBody.counts).toBeDefined();
    expect(getBody.filePath).toBeUndefined(); // Server path is not leaked

    // Verify GET /documents/:id/chunks endpoint returns 200 with pagination
    const chunksRes = await app.handle(
      new Request(`http://localhost:3000/documents/${body.id}/chunks`, {
        method: "GET",
      })
    );
    expect(chunksRes.status).toBe(200);
    const chunksBody = (await chunksRes.json()) as {
      pagination: { total: number };
    };
    expect(chunksBody.pagination).toBeDefined();
  });

  test("GET /documents/:id returns 404 for non-existent document", async () => {
    const nonExistentId = "00000000-0000-0000-0000-000000000000";
    const res = await app.handle(
      new Request(`http://localhost:3000/documents/${nonExistentId}`, {
        method: "GET",
      })
    );
    expect(res.status).toBe(404);
  });
});
