import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import * as canvas from "@napi-rs/canvas";

// Ensure globalThis symbols are wired for unpdf's canvas factory in Bun
(globalThis as unknown as Record<symbol, unknown>)[
  Symbol.for("unpdf.canvasModule")
] = canvas;
(globalThis as unknown as { Path2D?: unknown }).Path2D = canvas.Path2D;

const REPO_ROOT = resolve(import.meta.dirname, "../../../../");
const UPLOAD_DIR = resolve(REPO_ROOT, process.env.UPLOAD_DIR || "uploads");

export interface RenderResult {
  imagePath: string;
}

/**
 * Renders multiple PDF pages into images sharing a single PDF document proxy.
 * Uses RENDER_SCALE (defaults to 1.5) to keep charts legible without excessive memory.
 */
export const renderBatchImages = async (
  documentId: string,
  filePath: string,
  pages: number[]
): Promise<Map<number, string>> => {
  const { getDocumentProxy } = await import("unpdf");
  const buf = await globalThis.Bun.file(filePath).arrayBuffer();
  const pdf = await getDocumentProxy(new Uint8Array(buf));

  const scale = Number(process.env.RENDER_SCALE) || 1.5;
  const targetDir = resolve(UPLOAD_DIR, "images", documentId);
  await mkdir(targetDir, { recursive: true });

  const renderedPages = new Map<number, string>();

  try {
    for (const pageNumber of pages) {
      const page = await pdf.getPage(pageNumber);
      const targetPath = resolve(targetDir, `p${pageNumber}.png`);
      let canvasInstance: canvas.Canvas | null = null;

      try {
        const viewport = page.getViewport({ scale });
        canvasInstance = canvas.createCanvas(viewport.width, viewport.height);
        const ctx = canvasInstance.getContext("2d");

        await page.render({
          canvasContext: ctx as unknown as CanvasRenderingContext2D,
          viewport,
        } as unknown as Parameters<typeof page.render>[0]).promise;

        const pngBuffer = canvasInstance.toBuffer("image/png");
        await globalThis.Bun.write(targetPath, pngBuffer);
        renderedPages.set(pageNumber, targetPath);
      } finally {
        page.cleanup();
        if (canvasInstance) {
          canvasInstance.width = 0;
          canvasInstance.height = 0;
        }
      }
    }
  } finally {
    if (
      typeof (pdf as unknown as { cleanup?: () => void }).cleanup === "function"
    ) {
      (pdf as unknown as { cleanup: () => void }).cleanup();
    }
    if (
      typeof (pdf as unknown as { destroy?: () => Promise<void> | void })
        .destroy === "function"
    ) {
      await (
        pdf as unknown as { destroy: () => Promise<void> | void }
      ).destroy();
    }
  }

  return renderedPages;
};

/**
 * Single-page image rendering wrapper preserving backwards compatibility.
 */
export const renderPageImage = async (
  documentId: string,
  pageNumber: number,
  filePath: string
): Promise<string> => {
  const rendered = await renderBatchImages(documentId, filePath, [pageNumber]);
  const imagePath = rendered.get(pageNumber);
  if (!imagePath) {
    throw new Error(
      `Failed to render image for document ${documentId} page ${pageNumber}`
    );
  }
  return imagePath;
};

export const imagePathToDataUrl = async (
  imagePath: string
): Promise<string> => {
  const buf = await globalThis.Bun.file(imagePath).arrayBuffer();
  const base64 = Buffer.from(buf).toString("base64");
  return `data:image/png;base64,${base64}`;
};
