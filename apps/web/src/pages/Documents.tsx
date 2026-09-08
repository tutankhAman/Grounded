import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  Clock,
  Database,
  FileText,
  RefreshCw,
} from "lucide-react";
import { useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { UploadButton } from "../components/UploadButton";
import { useDocumentStatus } from "../hooks/useDocumentStatus";
import { formatEta } from "../lib/format";
import { fetchDocuments, queryKeys } from "../lib/query";

interface DocumentItem {
  errorMessage: string | null;
  filename: string;
  id: string;
  pageCount: number | null;
  status: string;
  uploadedAt: string | Date;
}

function DocumentRow({
  doc,
  isHighlighted,
}: {
  doc: DocumentItem;
  isHighlighted: boolean;
}) {
  const {
    error: wsError,
    errorMessage,
    etaMs,
    progress,
    reconnect,
    stage,
    status: liveStatus,
  } = useDocumentStatus(doc.id, doc.status);

  const currentStatus = liveStatus || doc.status;
  const statusText = currentStatus === "done" ? "PROCESSED" : currentStatus;
  const isDone = currentStatus === "done";
  const isFailed = currentStatus === "failed";
  const isProcessing = !(isDone || isFailed);

  const currentProgress = progress?.current ?? 0;
  const totalProgress = progress?.total ?? doc.pageCount ?? 1;
  const progressPercent = Math.min(
    100,
    Math.round((currentProgress / Math.max(1, totalProgress)) * 100)
  );

  return (
    <div
      style={{
        alignItems: "center",
        background: isHighlighted ? "var(--card-bg-hover)" : "var(--card-bg)",
        border: isHighlighted
          ? "1px solid var(--accent-olive)"
          : "1px solid var(--border-color)",
        borderRadius: 10,
        display: "grid",
        gap: 16,
        gridTemplateColumns:
          "minmax(200px, 2fr) 140px minmax(180px, 1.5fr) 120px",
        padding: "16px 20px",
        transition: "all 0.15s ease",
      }}
    >
      {/* Col 1: Filename & Upload Time */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 4,
          minWidth: 0,
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
          <FileText
            size={16}
            style={{ color: "var(--accent-olive)", flexShrink: 0 }}
          />
          <span
            style={{
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={doc.filename}
          >
            {doc.filename}
          </span>
        </div>
        <div
          style={{
            alignItems: "center",
            color: "var(--text-dim)",
            display: "flex",
            fontSize: 12,
            gap: 6,
          }}
        >
          <Clock size={12} />
          <span>{new Date(doc.uploadedAt).toLocaleString()}</span>
          {Boolean(doc.pageCount) && <span>· {doc.pageCount} pages</span>}
        </div>
      </div>

      {/* Col 2: Status Indicator */}
      <div>
        <span className={`badge badge-${currentStatus}`}>
          <span className="badge-dot" />
          <span>{statusText}</span>
        </span>
      </div>

      {/* Col 3: Live Progress or Error */}
      <div>
        {isProcessing && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            <div
              style={{
                alignItems: "center",
                display: "flex",
                fontSize: 12,
                justifyContent: "space-between",
              }}
            >
              <span
                style={{
                  color: "var(--text-muted)",
                  textTransform: "capitalize",
                }}
              >
                {stage || currentStatus}...
              </span>
              <span
                className="font-mono"
                style={{ color: "var(--accent-olive-light)" }}
              >
                {progressPercent}% ({currentProgress}/{totalProgress} p.)
              </span>
            </div>
            <div
              style={{
                background: "var(--border-color)",
                borderRadius: 4,
                height: 6,
                overflow: "hidden",
                width: "100%",
              }}
            >
              <div
                style={{
                  background: "var(--accent-olive)",
                  height: "100%",
                  transition: "width 0.3s ease",
                  width: `${progressPercent}%`,
                }}
              />
            </div>
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              {formatEta(etaMs) ?? "estimating…"}
            </span>
          </div>
        )}

        {isFailed && (
          <div
            style={{
              alignItems: "center",
              color: "var(--accent-red)",
              display: "flex",
              fontSize: 12,
              gap: 6,
            }}
          >
            <AlertCircle size={14} />
            <span
              style={{
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={errorMessage || doc.errorMessage || "Processing failed"}
            >
              {errorMessage || doc.errorMessage || "Processing failed"}
            </span>
          </div>
        )}

        {isDone && (
          <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Pipeline ingestion complete
          </span>
        )}

        {Boolean(wsError) && (
          <div
            style={{
              alignItems: "center",
              display: "flex",
              gap: 6,
              marginTop: 4,
            }}
          >
            <span style={{ color: "var(--accent-yellow)", fontSize: 11 }}>
              {wsError}
            </span>
            <button
              onClick={reconnect}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--accent-olive-light)",
                cursor: "pointer",
                padding: 0,
              }}
              title="Reconnect status stream"
              type="button"
            >
              <RefreshCw size={11} />
            </button>
          </div>
        )}
      </div>

      {/* Col 4: Action */}
      <div style={{ display: "flex", justifyContent: "flex-end" }}>
        {isDone ? (
          <Link
            style={{
              alignItems: "center",
              background: "var(--card-bg-hover)",
              border: "1px solid var(--border-color)",
              borderRadius: 6,
              color: "var(--text-main)",
              display: "inline-flex",
              fontSize: 12,
              fontWeight: 500,
              gap: 6,
              padding: "6px 12px",
              transition: "border-color 0.15s ease",
            }}
            to={`/facts?documentId=${doc.id}`}
          >
            <Database size={13} style={{ color: "var(--accent-olive)" }} />
            <span>View facts</span>
          </Link>
        ) : (
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
            Processing...
          </span>
        )}
      </div>
    </div>
  );
}

export function DocumentsPage() {
  const [searchParams] = useSearchParams();
  const highlightedId = searchParams.get("highlight");

  const {
    data: documentsList = [],
    error,
    isLoading,
    refetch,
  } = useQuery({
    queryFn: fetchDocuments,
    queryKey: queryKeys.documents(),
  });

  const handleRefresh = useCallback(() => {
    refetch();
  }, [refetch]);

  return (
    <div
      style={{
        margin: "0 auto",
        maxWidth: 1100,
        padding: "32px 36px",
        width: "100%",
      }}
    >
      {/* Header */}
      <div
        style={{
          alignItems: "center",
          borderBottom: "1px solid var(--border-color)",
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 28,
          paddingBottom: 20,
        }}
      >
        <div>
          <h1
            style={{
              fontSize: 24,
              fontWeight: 700,
              letterSpacing: "-0.02em",
              marginBottom: 4,
            }}
          >
            Documents
          </h1>
          <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
            Manage source documents and track ingestion, extraction, and graph
            reconciliation progress.
          </p>
        </div>
        <div style={{ alignItems: "center", display: "flex", gap: 12 }}>
          <button
            onClick={handleRefresh}
            style={{
              alignItems: "center",
              background: "var(--card-bg)",
              border: "1px solid var(--border-color)",
              borderRadius: 6,
              color: "var(--text-muted)",
              cursor: "pointer",
              display: "flex",
              fontSize: 13,
              gap: 6,
              padding: "8px 12px",
            }}
            type="button"
          >
            <RefreshCw size={13} />
            <span>Refresh</span>
          </button>
          <UploadButton variant="header" />
        </div>
      </div>

      {/* List */}
      {isLoading ? (
        <div
          style={{
            color: "var(--text-muted)",
            padding: "40px 0",
            textAlign: "center",
          }}
        >
          Loading documents...
        </div>
      ) : error ? (
        <div
          style={{
            background: "var(--accent-red-bg)",
            border: "1px solid rgba(201, 58, 68, 0.35)",
            borderRadius: 8,
            color: "var(--accent-red)",
            padding: 16,
          }}
        >
          Failed to load documents: {(error as Error).message}
        </div>
      ) : documentsList.length === 0 ? (
        <div
          style={{
            alignItems: "center",
            background: "var(--card-bg)",
            border: "1px dashed var(--border-color)",
            borderRadius: 12,
            display: "flex",
            flexDirection: "column",
            gap: 16,
            justifyContent: "center",
            padding: "60px 20px",
            textAlign: "center",
          }}
        >
          <div
            style={{
              alignItems: "center",
              background: "var(--card-bg-hover)",
              borderRadius: "50%",
              display: "flex",
              height: 52,
              justifyContent: "center",
              width: 52,
            }}
          >
            <FileText size={24} style={{ color: "var(--accent-olive)" }} />
          </div>
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
              No documents ingested yet
            </h3>
            <p
              style={{
                color: "var(--text-muted)",
                fontSize: 13,
                maxWidth: 360,
              }}
            >
              Upload your first PDF to initiate extraction, entity resolution,
              and factual reconciliation.
            </p>
          </div>
          <UploadButton variant="header" />
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {documentsList.map((doc: DocumentItem) => (
            <DocumentRow
              doc={doc}
              isHighlighted={highlightedId === doc.id}
              key={doc.id}
            />
          ))}
        </div>
      )}
    </div>
  );
}
