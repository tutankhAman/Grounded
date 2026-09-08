import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FileText,
  Loader2,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import * as pdfjsLib from "pdfjs-dist";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// Configure pdfjs worker via standard Vite URL constructor
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

export interface TextRun {
  fontName?: string;
  height: number;
  pageNumber?: number;
  text: string;
  width: number;
  x: number;
  y: number;
}

interface PDFViewerProps {
  documentId: string;
  filename?: string | null;
  initialPage?: number;
  positionData?: unknown;
  sourceQuote?: string | null;
}

function findMatchingRuns(runs: TextRun[], quote: string): TextRun[] {
  if (runs.length === 0 || !quote) {
    return [];
  }
  const fullTextPieces: string[] = [];
  const runRanges: { end: number; index: number; start: number }[] = [];
  let currentLength = 0;

  for (let i = 0; i < runs.length; i++) {
    const text = runs[i].text || "";
    const start = currentLength;
    fullTextPieces.push(text);
    currentLength += text.length + 1;
    runRanges.push({ end: currentLength, index: i, start });
  }

  const fullText = fullTextPieces.join(" ");
  const normFull = fullText.replace(/\s+/g, " ").trim().toLowerCase();
  const normQuote = quote.replace(/\s+/g, " ").trim().toLowerCase();

  let matchIdx = normFull.indexOf(normQuote);
  if (matchIdx === -1) {
    const cleanFull = normFull.replace(/[^\w]/g, "");
    const cleanQuote = normQuote.replace(/[^\w]/g, "");
    if (cleanQuote.length > 5 && cleanFull.includes(cleanQuote)) {
      matchIdx = normFull.indexOf(normQuote.slice(0, 15));
    }
  }

  if (matchIdx === -1) {
    return [];
  }

  const matchEnd = matchIdx + normQuote.length;
  const matchedIndices = new Set<number>();

  for (const range of runRanges) {
    if (range.start <= matchEnd && range.end >= matchIdx) {
      matchedIndices.add(range.index);
    }
  }

  return runs.filter((_, idx) => matchedIndices.has(idx));
}

async function fetchPdfDocument(
  documentId: string
): Promise<pdfjsLib.PDFDocumentProxy> {
  const apiUrl = import.meta.env.VITE_API_URL || "http://localhost:3000";
  const fileUrl = `${apiUrl}/documents/${documentId}/file`;
  const res = await fetch(fileUrl);
  if (!res.ok) {
    throw new Error(`Failed to load PDF (${res.status} ${res.statusText})`);
  }
  const bytes = await res.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(bytes),
  });
  return await loadingTask.promise;
}

export function PDFViewer({
  documentId,
  filename,
  initialPage = 1,
  positionData,
  sourceQuote,
}: PDFViewerProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [totalPages, setTotalPages] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [viewportSize, setViewportSize] = useState<{
    height: number;
    width: number;
  }>({ height: 0, width: 0 });

  const runs: TextRun[] = useMemo(() => {
    if (!positionData) {
      return [];
    }
    if (Array.isArray(positionData)) {
      return positionData as TextRun[];
    }
    return [];
  }, [positionData]);

  // Update page when initialPage changes
  useEffect(() => {
    if (initialPage && initialPage > 0) {
      setCurrentPage(initialPage);
    }
  }, [initialPage]);

  // 1. Fetch PDF bytes as arrayBuffer and load PDF document
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);

    async function load() {
      try {
        const doc = await fetchPdfDocument(documentId);
        if (!active) {
          return;
        }
        setPdfDoc(doc);
        setTotalPages(doc.numPages);
        setLoading(false);
      } catch (err: unknown) {
        if (!active) {
          return;
        }
        setError(
          err instanceof Error ? err.message : "Failed to parse PDF document"
        );
        setLoading(false);
      }
    }

    load();

    return () => {
      active = false;
    };
  }, [documentId]);

  // 2. Render current page to canvas & compute viewport
  const [renderedViewport, setRenderedViewport] =
    useState<pdfjsLib.PageViewport | null>(null);

  useEffect(() => {
    if (!(pdfDoc && canvasRef.current)) {
      return;
    }

    let renderTask: pdfjsLib.RenderTask | null = null;
    let cancelled = false;

    async function renderPage() {
      if (!pdfDoc) {
        return;
      }
      try {
        const page = await pdfDoc.getPage(currentPage);
        if (cancelled || !canvasRef.current) {
          return;
        }
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d");
        if (!context) {
          return;
        }

        const viewport = page.getViewport({ scale });
        setRenderedViewport(viewport);
        setViewportSize({ height: viewport.height, width: viewport.width });

        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);

        context.clearRect(0, 0, canvas.width, canvas.height);

        renderTask = page.render({
          canvas,
          canvasContext: context,
          viewport,
        });

        await renderTask.promise;
      } catch (err: unknown) {
        if ((err as { name?: string }).name !== "RenderingCancelledException") {
          console.error("PDF render error:", err);
        }
      }
    }

    renderPage();

    return () => {
      cancelled = true;
      if (renderTask) {
        renderTask.cancel();
      }
    };
  }, [pdfDoc, currentPage, scale]);

  // 3. Quote to runs matching (finding highlighted runs)
  const highlightedRuns = useMemo(() => {
    if (!(sourceQuote && runs) || currentPage !== initialPage) {
      return [];
    }
    return findMatchingRuns(runs, sourceQuote);
  }, [sourceQuote, runs, currentPage, initialPage]);

  // Transform run PDF coordinates to canvas coordinates using convertToViewportPoint
  const highlightRects = useMemo(() => {
    if (!renderedViewport || highlightedRuns.length === 0) {
      return [];
    }

    return highlightedRuns.map((run, i) => {
      // In PDF coordinates, (run.x, run.y) is bottom-left
      // Convert (run.x, run.y) and (run.x + run.width, run.y + run.height)
      const p1 = renderedViewport.convertToViewportPoint(run.x, run.y);
      const p2 = renderedViewport.convertToViewportPoint(
        run.x + run.width,
        run.y + run.height
      );

      const left = Math.min(p1[0], p2[0]);
      const top = Math.min(p1[1], p2[1]);
      const width = Math.max(4, Math.abs(p2[0] - p1[0]));
      const height = Math.max(8, Math.abs(p2[1] - p1[1]));

      return {
        height,
        id: `hl-${i}`,
        left,
        top,
        width,
      };
    });
  }, [highlightedRuns, renderedViewport]);

  const handlePrevPage = useCallback(() => {
    setCurrentPage((p) => Math.max(1, p - 1));
  }, []);

  const handleNextPage = useCallback(() => {
    setCurrentPage((p) => Math.min(totalPages, p + 1));
  }, [totalPages]);

  const handleZoomOut = useCallback(() => {
    setScale((s) => Math.max(0.6, s - 0.2));
  }, []);

  const handleZoomIn = useCallback(() => {
    setScale((s) => Math.min(2.5, s + 0.2));
  }, []);

  return (
    <div
      style={{
        background: "var(--card-bg)",
        border: "1px solid var(--border-color)",
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: 500,
        overflow: "hidden",
      }}
    >
      {/* Viewer Toolbar */}
      <div
        style={{
          alignItems: "center",
          background: "var(--sidebar-bg)",
          borderBottom: "1px solid var(--border-color)",
          display: "flex",
          justifyContent: "space-between",
          padding: "10px 16px",
        }}
      >
        {/* Document Info */}
        <div
          style={{ alignItems: "center", display: "flex", gap: 8, minWidth: 0 }}
        >
          <FileText
            size={16}
            style={{ color: "var(--accent-olive)", flexShrink: 0 }}
          />
          <span
            style={{
              fontSize: 13,
              fontWeight: 600,
              maxWidth: 240,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={filename || "Document Viewer"}
          >
            {filename || "Document"}
          </span>
        </div>

        {/* Page Nav Controls */}
        <div style={{ alignItems: "center", display: "flex", gap: 6 }}>
          <button
            disabled={currentPage <= 1 || loading}
            onClick={handlePrevPage}
            style={{
              alignItems: "center",
              background: "var(--card-bg)",
              border: "1px solid var(--border-color)",
              borderRadius: 4,
              color: currentPage <= 1 ? "var(--text-dim)" : "var(--text-main)",
              cursor: currentPage <= 1 ? "not-allowed" : "pointer",
              display: "flex",
              padding: "4px 8px",
            }}
            title="Previous page"
            type="button"
          >
            <ChevronLeft size={14} />
          </button>
          <span
            className="font-mono"
            style={{
              color: "var(--text-muted)",
              fontSize: 12,
              padding: "0 4px",
            }}
          >
            {currentPage} / {totalPages}
          </span>
          <button
            disabled={currentPage >= totalPages || loading}
            onClick={handleNextPage}
            style={{
              alignItems: "center",
              background: "var(--card-bg)",
              border: "1px solid var(--border-color)",
              borderRadius: 4,
              color:
                currentPage >= totalPages
                  ? "var(--text-dim)"
                  : "var(--text-main)",
              cursor: currentPage >= totalPages ? "not-allowed" : "pointer",
              display: "flex",
              padding: "4px 8px",
            }}
            title="Next page"
            type="button"
          >
            <ChevronRight size={14} />
          </button>
        </div>

        {/* Zoom Controls */}
        <div style={{ alignItems: "center", display: "flex", gap: 6 }}>
          <button
            onClick={handleZoomOut}
            style={{
              background: "var(--card-bg)",
              border: "1px solid var(--border-color)",
              borderRadius: 4,
              color: "var(--text-muted)",
              cursor: "pointer",
              display: "flex",
              padding: "4px 8px",
            }}
            title="Zoom out"
            type="button"
          >
            <ZoomOut size={14} />
          </button>
          <span
            className="font-mono"
            style={{
              color: "var(--text-dim)",
              fontSize: 11,
              textAlign: "center",
              width: 36,
            }}
          >
            {Math.round(scale * 100)}%
          </span>
          <button
            onClick={handleZoomIn}
            style={{
              background: "var(--card-bg)",
              border: "1px solid var(--border-color)",
              borderRadius: 4,
              color: "var(--text-muted)",
              cursor: "pointer",
              display: "flex",
              padding: "4px 8px",
            }}
            title="Zoom in"
            type="button"
          >
            <ZoomIn size={14} />
          </button>
        </div>
      </div>

      {/* Highlighting status indicator */}
      {Boolean(sourceQuote) && (
        <div
          style={{
            alignItems: "center",
            background:
              highlightRects.length > 0
                ? "rgba(159, 168, 85, 0.12)"
                : "rgba(229, 192, 123, 0.12)",
            borderBottom: "1px solid var(--border-color)",
            color:
              highlightRects.length > 0
                ? "var(--accent-olive-light)"
                : "var(--accent-yellow)",
            display: "flex",
            fontSize: 12,
            gap: 8,
            padding: "6px 16px",
          }}
        >
          {highlightRects.length > 0 ? (
            <span>
              ✓ Source quote highlighted ({highlightRects.length} text runs
              matched)
            </span>
          ) : (
            <div style={{ alignItems: "center", display: "flex", gap: 6 }}>
              <AlertTriangle size={13} />
              <span>
                Exact quote coordinate unanchored on this page (quote shown
                unhighlighted)
              </span>
            </div>
          )}
        </div>
      )}

      {/* Main Canvas + Overlay Area */}
      <div
        style={{
          alignItems: "flex-start",
          background: "#08090b",
          display: "flex",
          flex: 1,
          justifyContent: "center",
          overflow: "auto",
          padding: 24,
          position: "relative",
        }}
      >
        {loading ? (
          <div
            style={{
              alignItems: "center",
              color: "var(--text-muted)",
              display: "flex",
              flexDirection: "column",
              gap: 12,
              justifyContent: "center",
              margin: "auto",
            }}
          >
            <Loader2
              className="animate-spin"
              size={28}
              style={{ color: "var(--accent-olive)" }}
            />
            <span style={{ fontSize: 13 }}>Rendering PDF page...</span>
          </div>
        ) : error ? (
          <div
            style={{
              alignItems: "center",
              color: "var(--accent-red)",
              display: "flex",
              flexDirection: "column",
              gap: 8,
              justifyContent: "center",
              margin: "auto",
              maxWidth: 360,
              textAlign: "center",
            }}
          >
            <span style={{ fontSize: 14, fontWeight: 600 }}>Viewer Error</span>
            <span style={{ fontSize: 13 }}>{error}</span>
          </div>
        ) : (
          <div
            style={{
              boxShadow: "0 8px 32px rgba(0,0,0,0.6)",
              height: viewportSize.height || "auto",
              position: "relative",
              width: viewportSize.width || "auto",
            }}
          >
            {/* PDF Canvas Layer */}
            <canvas
              ref={canvasRef}
              style={{
                display: "block",
                height: viewportSize.height,
                width: viewportSize.width,
              }}
            />

            {/* SVG Evidence Overlay Layer */}
            <svg
              aria-label="Evidence highlights"
              role="img"
              style={{
                height: viewportSize.height,
                left: 0,
                pointerEvents: "none",
                position: "absolute",
                top: 0,
                width: viewportSize.width,
              }}
            >
              <title>Evidence highlights</title>
              {highlightRects.map((rect) => (
                <rect
                  fill="rgba(255, 230, 0, 0.4)"
                  height={rect.height}
                  key={rect.id}
                  rx={2}
                  stroke="rgba(230, 180, 0, 0.75)"
                  strokeWidth={1}
                  width={rect.width}
                  x={rect.left}
                  y={rect.top}
                />
              ))}
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}
