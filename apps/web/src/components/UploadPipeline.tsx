import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Database,
  FileText,
  GitCompare,
  Layers,
  Loader2,
  Upload,
  X,
} from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useDocumentStatus } from "../hooks/useDocumentStatus";
import { formatEta } from "../lib/format";
import { queryKeys, uploadDocument } from "../lib/query";

const STAGE_ORDER = ["parse", "extract", "resolve", "reconcile"] as const;

interface StageMeta {
  description: string;
  icon: React.ComponentType<{ size?: number; style?: React.CSSProperties }>;
  id: string;
  label: string;
}

const STAGES: StageMeta[] = [
  {
    description: "PDF received and queued",
    icon: Upload,
    id: "upload",
    label: "Upload",
  },
  {
    description: "Streaming pages to text",
    icon: FileText,
    id: "parse",
    label: "Parsing",
  },
  {
    description: "LLM claim extraction",
    icon: Database,
    id: "extract",
    label: "Extracting",
  },
  {
    description: "Clustering entity mentions",
    icon: Layers,
    id: "resolve",
    label: "Resolving",
  },
  {
    description: "Cross-doc fact comparison",
    icon: GitCompare,
    id: "reconcile",
    label: "Reconciling",
  },
];

type StageState = "active" | "done" | "failed" | "pending";

interface StageSnapshot {
  activeIdx: number;
  failedIdx: number;
  isDone: boolean;
}

function snapshotStages(
  currentStatus: string,
  stage: string | null
): StageSnapshot {
  const isDone = currentStatus === "done";
  const failedIdx = STAGE_ORDER.indexOf(
    (stage ?? "") as (typeof STAGE_ORDER)[number]
  );
  const rawActiveIdx = failedIdx;
  // Stage unknown but still running (e.g. between jobs): pin to first stage,
  // shown without page counts.
  const activeIdx =
    isDone || currentStatus === "failed"
      ? -1
      : rawActiveIdx === -1
        ? 0
        : rawActiveIdx;
  return { activeIdx, failedIdx, isDone };
}

function resolveStageState(
  id: string,
  snapshot: StageSnapshot,
  isFailed: boolean
): StageState {
  if (id === "upload" || snapshot.isDone) {
    return "done";
  }
  const idx = STAGE_ORDER.indexOf(id as (typeof STAGE_ORDER)[number]);
  if (isFailed) {
    if (idx === snapshot.failedIdx) {
      return "failed";
    }
    return idx < snapshot.failedIdx ? "done" : "pending";
  }
  if (idx < snapshot.activeIdx) {
    return "done";
  }
  return idx === snapshot.activeIdx ? "active" : "pending";
}

/** Animated ellipsis for active stages. The label text stays readable for
 * screen readers; only the dots are decorative. */
function LoadingDots() {
  return (
    <span aria-hidden="true" className="loading-dots" style={{ width: 18 }} />
  );
}

const STAGE_STATE_STYLES: Record<
  StageState,
  { background: string; border: string; labelColor: string }
> = {
  active: {
    background: "var(--accent-olive-bg)",
    border: "1px solid rgba(109, 125, 36, 0.5)",
    labelColor: "var(--accent-olive-light)",
  },
  done: {
    background: "var(--accent-green-bg)",
    border: "1px solid rgba(47, 125, 59, 0.35)",
    labelColor: "var(--accent-green)",
  },
  failed: {
    background: "var(--accent-red-bg)",
    border: "1px solid rgba(201, 58, 68, 0.45)",
    labelColor: "var(--accent-red)",
  },
  pending: {
    background: "var(--sidebar-bg)",
    border: "1px solid var(--border-subtle)",
    labelColor: "var(--text-muted)",
  },
};

function StageStateIcon({
  icon: Icon,
  state,
}: {
  icon: StageMeta["icon"];
  state: StageState;
}) {
  if (state === "done") {
    return (
      <CheckCircle2
        size={15}
        style={{ color: "var(--accent-green)", flexShrink: 0 }}
      />
    );
  }
  if (state === "failed") {
    return (
      <AlertCircle
        size={15}
        style={{ color: "var(--accent-red)", flexShrink: 0 }}
      />
    );
  }
  const iconColor =
    state === "active" ? "var(--accent-olive-light)" : "var(--text-dim)";
  return <Icon size={15} style={{ color: iconColor, flexShrink: 0 }} />;
}

function stageSubLine(
  state: StageState,
  meta: StageMeta,
  progressText: string | null,
  errorMessage: string | null
): string {
  if (state === "done") {
    return meta.id === "upload" ? "Received" : "Complete";
  }
  if (state === "failed") {
    return errorMessage ?? "Stage failed";
  }
  if (state === "active") {
    return progressText ?? meta.description;
  }
  return "Waiting";
}

interface StageCardProps {
  errorMessage: string | null;
  meta: StageMeta;
  progressPercent: number;
  progressText: string | null;
  state: StageState;
}

function StageCard({
  errorMessage,
  meta,
  progressPercent,
  progressText,
  state,
}: StageCardProps) {
  const isActive = state === "active";
  const showBar = isActive && meta.id !== "upload" && progressText !== null;
  const styles = STAGE_STATE_STYLES[state];

  return (
    <div
      style={{
        background: styles.background,
        border: styles.border,
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
        opacity: state === "pending" ? 0.65 : 1,
        padding: "12px 14px",
      }}
    >
      <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
        <StageStateIcon icon={meta.icon} state={state} />
        <span
          style={{
            color: styles.labelColor,
            display: "inline-flex",
            fontSize: 13,
            fontWeight: isActive ? 700 : 600,
          }}
        >
          {meta.label}
          {isActive ? <LoadingDots /> : null}
        </span>
      </div>
      <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
        {stageSubLine(state, meta, progressText, errorMessage)}
      </span>
      {showBar ? (
        <div
          style={{
            background: "var(--border-color)",
            borderRadius: 4,
            height: 5,
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
      ) : null}
    </div>
  );
}

interface PipelineCardProps {
  documentId: string;
  filename: string;
  initialStatus?: string;
  onDismiss: (id: string) => void;
}

function PipelineCard({
  documentId,
  filename,
  initialStatus,
  onDismiss,
}: PipelineCardProps) {
  const { errorMessage, etaMs, progress, stage, status } = useDocumentStatus(
    documentId,
    initialStatus
  );

  const currentStatus = status ?? initialStatus ?? "pending";
  const isDone = currentStatus === "done";
  const isFailed = currentStatus === "failed";

  // Auto-dismiss shortly after success so the doc settles into the list below.
  useEffect(() => {
    if (!isDone) {
      return;
    }
    const timer = setTimeout(() => {
      onDismiss(documentId);
    }, 6000);
    return () => {
      clearTimeout(timer);
    };
  }, [isDone, documentId, onDismiss]);

  const handleDismiss = useCallback(() => {
    onDismiss(documentId);
  }, [documentId, onDismiss]);

  const snapshot = snapshotStages(currentStatus, stage);

  const current = progress?.current ?? 0;
  const total = progress?.total ?? 0;
  const hasCounts = total > 0;
  const percent = hasCounts
    ? Math.min(100, Math.round((current / Math.max(1, total)) * 100))
    : 0;
  const progressText = hasCounts
    ? `${current}/${total} pages · ${percent}%`
    : null;
  const etaText = formatEta(etaMs) ?? "estimating…";
  const headerNote = isFailed ? "failed" : etaText;
  const showDismiss = isDone || isFailed;

  return (
    <div
      style={{
        background: "var(--card-bg)",
        border: isFailed
          ? "1px solid rgba(201, 58, 68, 0.45)"
          : isDone
            ? "1px solid rgba(47, 125, 59, 0.45)"
            : "1px solid var(--accent-olive)",
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: "18px 20px",
      }}
    >
      {/* Card header */}
      <div
        style={{
          alignItems: "center",
          display: "flex",
          gap: 10,
          justifyContent: "space-between",
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            gap: 10,
            minWidth: 0,
          }}
        >
          {isDone ? (
            <CheckCircle2
              size={18}
              style={{ color: "var(--accent-green)", flexShrink: 0 }}
            />
          ) : isFailed ? (
            <AlertCircle
              size={18}
              style={{ color: "var(--accent-red)", flexShrink: 0 }}
            />
          ) : (
            <Loader2
              className="animate-spin"
              size={18}
              style={{ color: "var(--accent-olive)", flexShrink: 0 }}
            />
          )}
          <span
            style={{
              fontSize: 14,
              fontWeight: 600,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={filename}
          >
            {filename}
          </span>
        </div>
        <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
          {isDone ? (
            <Link
              style={{
                alignItems: "center",
                background: "var(--accent-olive)",
                borderRadius: 6,
                color: "#ffffff",
                display: "inline-flex",
                fontSize: 12,
                fontWeight: 600,
                gap: 6,
                padding: "6px 12px",
                textDecoration: "none",
              }}
              to={`/facts?documentId=${documentId}`}
            >
              View facts
            </Link>
          ) : (
            <span
              className="font-mono"
              style={{ color: "var(--text-muted)", fontSize: 12 }}
            >
              {headerNote}
            </span>
          )}
          {showDismiss ? (
            <button
              aria-label="Dismiss"
              onClick={handleDismiss}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                display: "flex",
                padding: 2,
              }}
              type="button"
            >
              <X size={14} />
            </button>
          ) : null}
        </div>
      </div>

      {/* Stage cards */}
      <div
        style={{
          display: "grid",
          gap: 10,
          gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
        }}
      >
        {STAGES.map((meta) => (
          <StageCard
            errorMessage={errorMessage}
            key={meta.id}
            meta={meta}
            progressPercent={percent}
            progressText={progressText}
            state={resolveStageState(meta.id, snapshot, isFailed)}
          />
        ))}
      </div>

      {isFailed && (
        <span style={{ color: "var(--accent-red)", fontSize: 12 }}>
          {errorMessage ?? "Processing failed."} The document stays stored — fix
          the cause and re-upload to retry.
        </span>
      )}
      {isDone && (
        <span style={{ color: "var(--accent-green)", fontSize: 12 }}>
          Pipeline complete — moving to processed documents.
        </span>
      )}
    </div>
  );
}

interface ActivePipeline {
  filename: string;
  id: string;
  status: string;
}

interface UploadPipelineProps {
  active: ActivePipeline[];
  onDismiss: (id: string) => void;
  onUploaded: (doc: { filename: string; id: string; status: string }) => void;
}

export function UploadPipeline({
  active,
  onDismiss,
  onUploaded,
}: UploadPipelineProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [localError, setLocalError] = useState<string | null>(null);
  const queryClient = useQueryClient();

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadDocument(file),
    onError: (err: Error) => {
      setLocalError(err.message || "Upload failed");
    },
    onSuccess: (data) => {
      setLocalError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.documents() });
      if (data && typeof data === "object" && "id" in data) {
        onUploaded({
          filename: data.filename,
          id: data.id,
          status: data.status,
        });
      }
    },
  });

  const submitFile = useCallback(
    (file: File | undefined) => {
      if (!file) {
        return;
      }
      if (file.type !== "application/pdf" && !file.name.endsWith(".pdf")) {
        setLocalError("Only PDF documents are supported.");
        return;
      }
      setLocalError(null);
      uploadMutation.mutate(file);
    },
    [uploadMutation]
  );

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      submitFile(file);
    },
    [submitFile]
  );

  const openPicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      submitFile(e.dataTransfer.files?.[0]);
    },
    [submitFile]
  );

  const isUploading = uploadMutation.isPending;

  return (
    <div
      style={{
        background: "var(--card-bg)",
        border: "1px solid var(--border-color)",
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        marginBottom: 28,
        padding: "20px 22px",
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <h2 style={{ fontSize: 16, fontWeight: 700 }}>Ingestion pipeline</h2>
        <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
          Parse → Extract → Resolve → Reconcile
        </span>
      </div>

      {/* Dropzone */}
      <button
        aria-label="Upload a PDF document: drag a file here or activate to browse"
        disabled={isUploading}
        onClick={openPicker}
        onDragLeave={handleDragLeave}
        onDragOver={handleDragOver}
        onDrop={handleDrop}
        style={{
          alignItems: "center",
          background: isDragging
            ? "var(--accent-olive-bg)"
            : "var(--sidebar-bg)",
          border: isDragging
            ? "2px dashed var(--accent-olive)"
            : "2px dashed var(--border-color)",
          borderRadius: 10,
          color: "var(--text-main)",
          cursor: isUploading ? "wait" : "pointer",
          display: "flex",
          flexDirection: "column",
          fontFamily: "inherit",
          gap: 10,
          justifyContent: "center",
          opacity: isUploading ? 0.75 : 1,
          padding: "30px 20px",
          textAlign: "center",
          transition: "all 0.15s ease",
          width: "100%",
        }}
        type="button"
      >
        <input
          accept="application/pdf"
          disabled={isUploading}
          onChange={handleFileChange}
          ref={fileInputRef}
          style={{ display: "none" }}
          type="file"
        />
        <span
          style={{
            alignItems: "center",
            background: "var(--accent-olive-bg)",
            borderRadius: "50%",
            display: "flex",
            height: 46,
            justifyContent: "center",
            width: 46,
          }}
        >
          {isUploading ? (
            <Loader2
              className="animate-spin"
              size={22}
              style={{ color: "var(--accent-olive-light)" }}
            />
          ) : (
            <Upload size={22} style={{ color: "var(--accent-olive-light)" }} />
          )}
        </span>
        <span>
          <span style={{ display: "block", fontSize: 14, fontWeight: 600 }}>
            {isUploading
              ? "Uploading…"
              : isDragging
                ? "Drop the PDF to start"
                : "Drag a PDF here, or click to browse"}
          </span>
          <span
            style={{
              color: "var(--text-muted)",
              display: "block",
              fontSize: 12,
              marginTop: 4,
            }}
          >
            PDF only · each upload runs its own incremental pipeline
          </span>
        </span>
      </button>

      {Boolean(localError) && (
        <div
          style={{
            alignItems: "center",
            background: "var(--accent-red-bg)",
            border: "1px solid rgba(201, 58, 68, 0.35)",
            borderRadius: 8,
            color: "var(--accent-red)",
            display: "flex",
            fontSize: 13,
            gap: 8,
            padding: "10px 14px",
          }}
        >
          <AlertCircle size={15} />
          <span>{localError}</span>
        </div>
      )}

      {/* Live pipeline cards */}
      {active.map((doc) => (
        <PipelineCard
          documentId={doc.id}
          filename={doc.filename}
          initialStatus={doc.status}
          key={doc.id}
          onDismiss={onDismiss}
        />
      ))}
    </div>
  );
}
