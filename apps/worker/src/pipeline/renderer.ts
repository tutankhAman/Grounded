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

export const renderPageImage = async (
  documentId: string,
  pageNumber: number,
  filePath: string
): Promise<string> => {
  // Dynamic import of unpdf after canvas module is registered
  const { getDocumentProxy } = await import("unpdf");
  const buf = await globalThis.Bun.file(filePath).arrayBuffer();
  const pdf = await getDocumentProxy(new Uint8Array(buf));

  const targetDir = resolve(UPLOAD_DIR, "images", documentId);
  await mkdir(targetDir, { recursive: true });
  const targetPath = resolve(targetDir, `p${pageNumber}.png`);

  let canvasInstance: ReturnType<typeof canvas.createCanvas> | null = null;

  try {
    const page = await pdf.getPage(pageNumber);
    try {
      const viewport = page.getViewport({ scale: 2 });
      canvasInstance = canvas.createCanvas(viewport.width, viewport.height);
      const ctx = canvasInstance.getContext("2d");

      await page.render({
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;

      const pngBuffer = canvasInstance.toBuffer("image/png");
      await globalThis.Bun.write(targetPath, pngBuffer);
    } finally {
      page.cleanup();
    }
  } finally {
    if (canvasInstance) {
      canvasInstance.width = 0;
      canvasInstance.height = 0;
    }
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

  return targetPath;
};

export const imagePathToDataUrl = async (
  imagePath: string
): Promise<string> => {
  const buf = await globalThis.Bun.file(imagePath).arrayBuffer();
  const base64 = Buffer.from(buf).toString("base64");
  return `data:image/png;base64,${base64}`;
};
