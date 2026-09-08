import {
  DEFAULT_THRESHOLDS,
  getThresholds,
  type ParserThresholds,
} from "@grounded/db";
import { getDocumentProxy } from "unpdf";

export interface TextRun {
  fontName: string;
  height: number;
  pageNumber: number;
  text: string;
  width: number;
  x: number;
  y: number;
}

export interface TextItemLike {
  fontName?: string;
  height?: number;
  str?: string;
  transform?: number[];
  width?: number;
}

export interface TextContentLike {
  items: unknown[];
}

export interface PageClassification {
  avgWidth: number;
  isLowText: boolean;
  isTableHeavy: boolean;
  numericRatio: number;
  visionFlagged: boolean;
}

export interface ParsedChunk {
  chunkIndex: number;
  isLowText: boolean;
  isTableHeavy: boolean;
  pageNumber: number;
  rawText: string;
  runs: TextRun[];
  tokenEstimate: number;
}

export interface PageStreamResult {
  chunks: ParsedChunk[];
  pageHeight: number;
  pageNumber: number;
  pageWidth: number;
  totalPages: number;
}

const NUMERIC_TOKEN_REGEX = /^[0-9.,%$€£₹+-]+$/;

export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / 4);

export const runsFromTextContent = (
  pageNumber: number,
  textContent: TextContentLike
): { runs: TextRun[]; rawText: string } => {
  const runs: TextRun[] = [];
  const textPieces: string[] = [];

  for (const item of textContent.items) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const ti = item as TextItemLike;
    const str = ti.str?.trim();
    if (!str || str.length === 0) {
      continue;
    }

    const transform = Array.isArray(ti.transform)
      ? ti.transform
      : [0, 0, 0, 0, 0, 0];
    const x = Number(transform[4]) || 0;
    const y = Number(transform[5]) || 0;
    const width = Number(ti.width) || 0;
    // Fallback: transform[0] reflects horizontal scale / font size for standard upright text
    const height = Number(ti.height) || Math.abs(Number(transform[0])) || 0;
    const fontName = typeof ti.fontName === "string" ? ti.fontName : "";

    runs.push({
      fontName,
      height,
      pageNumber,
      text: str,
      width,
      x,
      y,
    });
    textPieces.push(str);
  }

  return {
    rawText: textPieces.join(" "),
    runs,
  };
};

export const classifyPage = (
  runs: TextRun[],
  rawText: string,
  pageWidth: number,
  thresholds: ParserThresholds = DEFAULT_THRESHOLDS
): PageClassification => {
  const total = runs.length;
  if (total === 0) {
    return {
      avgWidth: 0,
      isLowText: true,
      isTableHeavy: false,
      numericRatio: 0,
      visionFlagged: true,
    };
  }

  let numericCount = 0;
  let totalWidth = 0;

  for (const run of runs) {
    if (NUMERIC_TOKEN_REGEX.test(run.text)) {
      numericCount++;
    }
    totalWidth += run.width;
  }

  const numericRatio = numericCount / total;
  const avgWidth = totalWidth / total;

  const isTableHeavy =
    total >= 5 &&
    numericRatio >= thresholds.numericRatio &&
    avgWidth < thresholds.shortColWidthRatio * pageWidth;

  const isLowText =
    rawText.trim().length < thresholds.lowTextChars ||
    total < thresholds.lowTextMinItems;

  const visionFlagged = isTableHeavy || isLowText;

  return {
    avgWidth,
    isLowText,
    isTableHeavy,
    numericRatio,
    visionFlagged,
  };
};

export const splitOversizePage = (
  runs: TextRun[],
  pageNumber: number,
  rawText: string,
  classification: PageClassification,
  thresholds: ParserThresholds = DEFAULT_THRESHOLDS
): ParsedChunk[] => {
  const tokenCount = estimateTokens(rawText);

  // If page is within normal token limits or has too few runs to meaningfully split, emit single chunk
  if (tokenCount <= thresholds.chunkTokenSplit || runs.length <= 4) {
    return [
      {
        chunkIndex: 0,
        isLowText: classification.isLowText,
        isTableHeavy: classification.isTableHeavy,
        pageNumber,
        rawText,
        runs,
        tokenEstimate: tokenCount,
      },
    ];
  }

  // Calculate median line height to identify paragraph/section vertical gaps
  const heights = runs
    .map((r) => r.height)
    .filter((h) => h > 0)
    .sort((a, b) => a - b);
  const medianHeight =
    heights.length > 0 ? heights[Math.floor(heights.length / 2)] : 10;
  const gapThreshold = 1.5 * medianHeight;

  const chunks: ParsedChunk[] = [];
  let currentRuns: TextRun[] = [];
  let currentPieces: string[] = [];

  for (let i = 0; i < runs.length; i++) {
    const currentRun = runs[i];
    currentRuns.push(currentRun);
    currentPieces.push(currentRun.text);

    const nextRun = runs[i + 1];
    const hasGap =
      nextRun !== undefined &&
      Math.abs(currentRun.y - nextRun.y) > gapThreshold;

    const currentText = currentPieces.join(" ");
    const currentTokens = estimateTokens(currentText);

    // Split if we hit a gap and have at least 25% of split target, or if hard limit reached
    const minSplitTokens = Math.max(
      250,
      Math.floor(thresholds.chunkTokenSplit / 4)
    );
    const shouldSplit =
      (hasGap && currentTokens >= minSplitTokens) ||
      currentTokens >= thresholds.chunkTokenSplit;

    if (shouldSplit) {
      chunks.push({
        chunkIndex: chunks.length,
        isLowText: classification.isLowText,
        isTableHeavy: classification.isTableHeavy,
        pageNumber,
        rawText: currentText,
        runs: [...currentRuns],
        tokenEstimate: currentTokens,
      });
      currentRuns = [];
      currentPieces = [];
    }
  }

  if (currentRuns.length > 0) {
    const remainderText = currentPieces.join(" ");
    chunks.push({
      chunkIndex: chunks.length,
      isLowText: classification.isLowText,
      isTableHeavy: classification.isTableHeavy,
      pageNumber,
      rawText: remainderText,
      runs: currentRuns,
      tokenEstimate: estimateTokens(remainderText),
    });
  }

  return chunks;
};

export async function* streamPages(
  filePath: string,
  overrides?: Partial<ParserThresholds>
): AsyncGenerator<PageStreamResult> {
  const thresholds = getThresholds(overrides);
  const buf = await globalThis.Bun.file(filePath).arrayBuffer();
  const fileBytes = new Uint8Array(buf);
  const pdf = await getDocumentProxy(fileBytes);

  try {
    const totalPages = pdf.numPages;

    for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      try {
        const textContent = await page.getTextContent();
        const viewport = page.getViewport({ scale: 1 });
        const pageWidth = viewport.width || 612;
        const pageHeight = viewport.height || 792;

        const { runs, rawText } = runsFromTextContent(
          pageNum,
          textContent as TextContentLike
        );
        const classification = classifyPage(
          runs,
          rawText,
          pageWidth,
          thresholds
        );
        const chunks = splitOversizePage(
          runs,
          pageNum,
          rawText,
          classification,
          thresholds
        );

        yield {
          chunks,
          pageHeight,
          pageNumber: pageNum,
          pageWidth,
          totalPages,
        };
      } finally {
        page.cleanup();
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
}
