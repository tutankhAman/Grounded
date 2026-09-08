import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, unlinkSync } from "node:fs";
import { db, documents, eq } from "@grounded/db";
import { app } from "../index";

describe("POST /documents API tests", () => {
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
      process.env.MAX_UPLOAD_MB = originalLimit;
    }
  });

  test("sanitizes traversal filename and writes file successfully", async () => {
    const pdfBlob = new Blob(
      ["%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF"],
      {
        type: "application/pdf",
      }
    );
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

    // Verify debug GET /documents/:id endpoint returns 200 with counts
    const getRes = await app.handle(
      new Request(`http://localhost:3000/documents/${body.id}`, {
        method: "GET",
      })
    );
    expect(getRes.status).toBe(200);
    const getBody = (await getRes.json()) as {
      id: string;
      counts: { chunks: number };
    };
    expect(getBody.id).toBe(body.id);
    expect(getBody.counts).toBeDefined();

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
