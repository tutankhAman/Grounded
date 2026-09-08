import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowUpCircle, Loader2, Upload } from "lucide-react";
import type React from "react";
import { useCallback, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { queryKeys, uploadDocument } from "../lib/query";

interface UploadButtonProps {
  className?: string;
  onSuccessNavigate?: boolean;
  variant?: "sidebar" | "header" | "inline";
}

export function UploadButton({
  className = "",
  onSuccessNavigate = true,
  variant = "sidebar",
}: UploadButtonProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const uploadMutation = useMutation({
    mutationFn: (file: File) => uploadDocument(file),
    onError: (err: Error) => {
      setUploadError(err.message || "Upload failed");
    },
    onSuccess: (data) => {
      setUploadError(null);
      queryClient.invalidateQueries({ queryKey: queryKeys.documents() });
      const docId =
        data && typeof data === "object" && "id" in data
          ? (data as { id: string }).id
          : "";
      if (onSuccessNavigate) {
        navigate(`/documents?highlight=${docId}`);
      }
    },
  });

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      e.target.value = "";
      if (!file) {
        return;
      }
      if (file.type !== "application/pdf" && !file.name.endsWith(".pdf")) {
        setUploadError("Only PDF documents are supported.");
        return;
      }
      setUploadError(null);
      uploadMutation.mutate(file);
    },
    [uploadMutation]
  );

  const handleButtonClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const isUploading = uploadMutation.isPending;

  if (variant === "header") {
    return (
      <div style={{ display: "inline-flex", flexDirection: "column", gap: 4 }}>
        <input
          accept="application/pdf"
          disabled={isUploading}
          onChange={handleFileChange}
          ref={fileInputRef}
          style={{ display: "none" }}
          type="file"
        />
        <button
          className={className}
          disabled={isUploading}
          onClick={handleButtonClick}
          style={{
            alignItems: "center",
            background: "var(--accent-olive)",
            border: "none",
            borderRadius: 6,
            color: "#ffffff",
            cursor: isUploading ? "not-allowed" : "pointer",
            display: "inline-flex",
            fontSize: 13,
            fontWeight: 600,
            gap: 6,
            opacity: isUploading ? 0.7 : 1,
            padding: "8px 14px",
            transition: "background 0.15s ease",
          }}
          type="button"
        >
          {isUploading ? (
            <Loader2 className="animate-spin" size={14} />
          ) : (
            <Upload size={14} />
          )}
          <span>{isUploading ? "Uploading..." : "Upload PDF"}</span>
        </button>
        {Boolean(uploadError) && (
          <span style={{ color: "var(--accent-red)", fontSize: 12 }}>
            {uploadError}
          </span>
        )}
      </div>
    );
  }

  return (
    <div
      className="upload-section"
      style={{
        borderTop: "1px solid var(--border-color)",
        display: "flex",
        flexDirection: "column",
        gap: 6,
        padding: "16px 14px",
      }}
    >
      <input
        accept="application/pdf"
        disabled={isUploading}
        onChange={handleFileChange}
        ref={fileInputRef}
        style={{ display: "none" }}
        type="file"
      />
      <button
        className={`upload-btn ${className}`}
        disabled={isUploading}
        onClick={handleButtonClick}
        style={{
          alignItems: "center",
          background: "var(--accent-olive-bg)",
          border: "1px solid rgba(109, 125, 36, 0.45)",
          borderRadius: 8,
          color: "var(--accent-olive-light)",
          cursor: isUploading ? "not-allowed" : "pointer",
          display: "flex",
          fontSize: 13,
          fontWeight: 600,
          gap: 8,
          justifyContent: "center",
          opacity: isUploading ? 0.7 : 1,
          padding: "10px 14px",
          transition: "all 0.15s ease",
          width: "100%",
        }}
        type="button"
      >
        {isUploading ? (
          <Loader2 className="animate-spin" size={16} />
        ) : (
          <ArrowUpCircle size={16} />
        )}
        <span className="upload-button-text">
          {isUploading ? "Uploading..." : "+ Upload PDF"}
        </span>
      </button>
      {Boolean(uploadError) && (
        <span
          style={{
            color: "var(--accent-red)",
            fontSize: 11,
            lineHeight: 1.2,
            textAlign: "center",
          }}
        >
          {uploadError}
        </span>
      )}
    </div>
  );
}
