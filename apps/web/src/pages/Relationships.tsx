import { useQuery } from "@tanstack/react-query";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  GitCompare,
  Layers,
} from "lucide-react";
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchRelationships, queryKeys } from "../lib/query";

const RELATION_TABS = [
  { id: "", label: "All Relationships" },
  { id: "corroborates", label: "Corroborated" },
  { id: "contradicts", label: "Contradicted" },
  { id: "reconciled", label: "Reconciled" },
  { id: "uncertain", label: "Uncertain" },
];

export interface RelationshipFact {
  documentFilename?: string | null;
  entityCanonicalName?: string | null;
  id: string;
  predicate: string;
  rawValue: string;
  sourcePage: number;
  sourceQuote: string;
  timeScope?: string | null;
}

export interface RelationshipItem {
  confidence: number;
  createdAt: string | Date;
  explanation: string;
  factA: RelationshipFact | null;
  factB: RelationshipFact | null;
  id: string;
  method: string;
  relationType: string;
}

function FactPreviewBox({
  fact,
  title,
}: {
  fact: RelationshipFact | null;
  title: string;
}) {
  if (!fact) {
    return (
      <div
        style={{
          background: "rgba(26, 29, 33, 0.03)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 8,
          padding: "14px 16px",
        }}
      >
        <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
          Fact details unavailable
        </span>
      </div>
    );
  }

  return (
    <div
      style={{
        background: "rgba(26, 29, 33, 0.03)",
        border: "1px solid var(--border-subtle)",
        borderRadius: 8,
        display: "flex",
        flexDirection: "column",
        gap: 8,
        padding: "14px 16px",
      }}
    >
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span
          style={{
            color: "var(--text-dim)",
            fontSize: 11,
            fontWeight: 600,
            textTransform: "uppercase",
          }}
        >
          {title}
        </span>
        <code
          style={{
            background: "rgba(26, 29, 33, 0.05)",
            borderRadius: 4,
            color: "var(--accent-olive-light)",
            fontSize: 11,
            padding: "2px 6px",
          }}
        >
          {fact.predicate}
        </code>
      </div>

      <div style={{ alignItems: "center", display: "flex", gap: 6 }}>
        <Layers size={13} style={{ color: "var(--accent-olive)" }} />
        <span style={{ fontSize: 13, fontWeight: 600 }}>
          {fact.entityCanonicalName || "Entity"}
        </span>
      </div>

      <div
        className="font-mono"
        style={{
          color: "var(--text-main)",
          fontSize: 16,
          fontWeight: 700,
        }}
      >
        {fact.rawValue}
        {Boolean(fact.timeScope) && (
          <span
            style={{
              color: "var(--text-dim)",
              fontSize: 12,
              marginLeft: 8,
            }}
          >
            ({fact.timeScope})
          </span>
        )}
      </div>

      <blockquote
        className="font-mono"
        style={{
          color: "var(--text-muted)",
          fontSize: 12,
          fontStyle: "italic",
          lineHeight: 1.4,
        }}
      >
        &ldquo;{fact.sourceQuote}&rdquo;
      </blockquote>

      <div
        style={{
          color: "var(--text-dim)",
          fontSize: 11,
          marginTop: "auto",
          paddingTop: 6,
        }}
      >
        {fact.documentFilename}, p.{fact.sourcePage}
      </div>
    </div>
  );
}

function RelationshipCard({
  rel,
  onNavigate,
}: {
  rel: RelationshipItem;
  onNavigate: (factId: string, relId: string) => void;
}) {
  const confPct = Math.round((rel.confidence || 1) * 100);

  const handleViewEvidence = useCallback(() => {
    if (rel.factA?.id) {
      onNavigate(rel.factA.id, rel.id);
    }
  }, [rel.factA?.id, rel.id, onNavigate]);

  return (
    <div
      style={{
        background: "var(--card-bg)",
        border: "1px solid var(--border-color)",
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        gap: 16,
        padding: "20px 24px",
        transition: "border-color 0.15s ease",
      }}
    >
      {/* Header: Badge, Method & Timestamp */}
      <div
        style={{
          alignItems: "center",
          borderBottom: "1px solid var(--border-subtle)",
          display: "flex",
          justifyContent: "space-between",
          paddingBottom: 12,
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
          <span className={`badge badge-${rel.relationType}`}>
            <span className="badge-dot" />
            {rel.relationType}
          </span>
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
            Method:{" "}
            <strong style={{ color: "var(--text-muted)" }}>{rel.method}</strong>{" "}
            · {confPct}% confidence
          </span>
        </div>

        <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
          {new Date(rel.createdAt).toLocaleString()}
        </span>
      </div>

      {/* Engine Explanation Box */}
      <div
        style={{
          background: "var(--sidebar-bg)",
          borderLeft: "3px solid var(--accent-olive)",
          borderRadius: "0 8px 8px 0",
          padding: "12px 16px",
        }}
      >
        <span
          style={{
            color: "var(--accent-olive-light)",
            display: "block",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.04em",
            marginBottom: 4,
            textTransform: "uppercase",
          }}
        >
          Engine Reasoning & Reconciliation
        </span>
        <p
          style={{
            color: "var(--text-main)",
            fontSize: 14,
            lineHeight: 1.55,
          }}
        >
          {rel.explanation}
        </p>
      </div>

      {/* Facts Comparison Grid */}
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))",
        }}
      >
        <FactPreviewBox fact={rel.factA} title="Subject Fact" />
        <FactPreviewBox fact={rel.factB} title="Comparison Fact" />
      </div>

      {/* Action */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          paddingTop: 4,
        }}
      >
        {Boolean(rel.factA) && (
          <button
            onClick={handleViewEvidence}
            style={{
              alignItems: "center",
              background: "var(--card-bg-hover)",
              border: "1px solid var(--border-color)",
              borderRadius: 6,
              color: "var(--accent-olive-light)",
              cursor: "pointer",
              display: "inline-flex",
              fontSize: 12,
              fontWeight: 600,
              gap: 6,
              padding: "8px 14px",
              transition: "all 0.15s ease",
            }}
            type="button"
          >
            <span>View in Grounded Evidence Viewer</span>
            <ArrowRight size={13} />
          </button>
        )}
      </div>
    </div>
  );
}

function RelationshipsPagination({
  page,
  totalPages,
  totalCount,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  totalCount: number;
  onPageChange: (nextPage: number) => void;
}) {
  const handlePrev = useCallback(() => {
    onPageChange(Math.max(1, page - 1));
  }, [onPageChange, page]);

  const handleNext = useCallback(() => {
    onPageChange(Math.min(totalPages, page + 1));
  }, [onPageChange, page, totalPages]);

  if (totalPages <= 1) {
    return null;
  }

  return (
    <div
      style={{
        alignItems: "center",
        display: "flex",
        justifyContent: "space-between",
        marginTop: 18,
      }}
    >
      <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
        Page {page} of {totalPages} ({totalCount} total)
      </span>
      <div style={{ display: "flex", gap: 8 }}>
        <button
          disabled={page <= 1}
          onClick={handlePrev}
          style={{
            alignItems: "center",
            background: "var(--card-bg)",
            border: "1px solid var(--border-color)",
            borderRadius: 6,
            color: page <= 1 ? "var(--text-dim)" : "var(--text-main)",
            cursor: page <= 1 ? "not-allowed" : "pointer",
            display: "flex",
            fontSize: 12,
            gap: 4,
            padding: "6px 12px",
          }}
          type="button"
        >
          <ChevronLeft size={14} />
          <span>Previous</span>
        </button>
        <button
          disabled={page >= totalPages}
          onClick={handleNext}
          style={{
            alignItems: "center",
            background: "var(--card-bg)",
            border: "1px solid var(--border-color)",
            borderRadius: 6,
            color: page >= totalPages ? "var(--text-dim)" : "var(--text-main)",
            cursor: page >= totalPages ? "not-allowed" : "pointer",
            display: "flex",
            fontSize: 12,
            gap: 4,
            padding: "6px 12px",
          }}
          type="button"
        >
          <span>Next</span>
          <ChevronRight size={14} />
        </button>
      </div>
    </div>
  );
}

interface TabButtonProps {
  id: string;
  isActive: boolean;
  label: string;
  onSelect: (id: string) => void;
}

function TabButton({ id, isActive, label, onSelect }: TabButtonProps) {
  const handleClick = useCallback(() => {
    onSelect(id);
  }, [id, onSelect]);

  return (
    <button
      key={id}
      onClick={handleClick}
      style={{
        alignItems: "center",
        background: "transparent",
        border: "none",
        borderBottom: isActive
          ? "2px solid var(--accent-olive)"
          : "2px solid transparent",
        color: isActive ? "var(--text-main)" : "var(--text-muted)",
        cursor: "pointer",
        display: "inline-flex",
        fontSize: 13,
        fontWeight: isActive ? 600 : 500,
        gap: 6,
        padding: "10px 14px",
        transition: "all 0.15s ease",
        whiteSpace: "nowrap",
      }}
      type="button"
    >
      <span>{label}</span>
    </button>
  );
}

export function RelationshipsPage() {
  const [activeTab, setActiveTab] = useState("");
  const [page, setPage] = useState(1);
  const limit = 20;
  const navigate = useNavigate();

  const handleSelectTab = useCallback((tabId: string) => {
    setActiveTab(tabId);
    setPage(1);
  }, []);

  const queryFilters = {
    limit: String(limit),
    page: String(page),
    relationType: activeTab || undefined,
  };

  const {
    data: result,
    error,
    isLoading,
  } = useQuery({
    queryFn: () => fetchRelationships(queryFilters),
    queryKey: queryKeys.relationships(queryFilters),
  });

  const relationships = (result?.data ?? []) as RelationshipItem[];
  const totalCount = result?.pagination.total ?? 0;
  const totalPages = result?.pagination.totalPages ?? 1;

  const handleNavigate = useCallback(
    (factId: string, relId: string) => {
      navigate(`/facts/${factId}?relationshipId=${relId}`);
    },
    [navigate]
  );

  return (
    <div
      style={{
        margin: "0 auto",
        maxWidth: 1200,
        padding: "32px 36px",
        width: "100%",
      }}
    >
      {/* Header */}
      <div
        style={{
          borderBottom: "1px solid var(--border-color)",
          marginBottom: 24,
          paddingBottom: 20,
        }}
      >
        <h1
          style={{
            fontSize: 24,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            marginBottom: 4,
          }}
        >
          Relationships & Reasoning
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
          Cross-document factual comparison, conflict detection, and LLM judge
          reconciliation.
        </p>
      </div>

      {/* Tabs */}
      <div
        style={{
          borderBottom: "1px solid var(--border-color)",
          display: "flex",
          gap: 8,
          marginBottom: 24,
          overflowX: "auto",
        }}
      >
        {RELATION_TABS.map((tab) => (
          <TabButton
            id={tab.id}
            isActive={activeTab === tab.id}
            key={tab.id}
            label={tab.label}
            onSelect={handleSelectTab}
          />
        ))}
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
          Loading relationships...
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
          Failed to load relationships: {(error as Error).message}
        </div>
      ) : relationships.length === 0 ? (
        <div
          style={{
            alignItems: "center",
            background: "var(--card-bg)",
            border: "1px dashed var(--border-color)",
            borderRadius: 10,
            display: "flex",
            flexDirection: "column",
            gap: 12,
            justifyContent: "center",
            padding: "60px 20px",
            textAlign: "center",
          }}
        >
          <GitCompare size={28} style={{ color: "var(--text-dim)" }} />
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
              No relationships found in this category
            </h3>
            <p
              style={{
                color: "var(--text-muted)",
                fontSize: 13,
                maxWidth: 360,
              }}
            >
              {activeTab
                ? `No ${activeTab} relationships recorded yet. Switch tabs or upload additional source documents to trigger cross-document comparisons.`
                : "Upload at least two related documents to initiate cross-document reconciliation."}
            </p>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {relationships.map((rel) => (
            <RelationshipCard
              key={rel.id}
              onNavigate={handleNavigate}
              rel={rel}
            />
          ))}

          <RelationshipsPagination
            onPageChange={setPage}
            page={page}
            totalCount={totalCount}
            totalPages={totalPages}
          />
        </div>
      )}
    </div>
  );
}
