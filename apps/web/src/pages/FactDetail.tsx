import { useQuery } from "@tanstack/react-query";
import {
  AlertCircle,
  ArrowLeft,
  Calendar,
  CheckCircle,
  ExternalLink,
  GitCompare,
  Layers,
  Scale,
  ShieldCheck,
} from "lucide-react";
import { useCallback } from "react";
import {
  Link,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { PDFViewer } from "../components/PDFViewer";
import { fetchFact, fetchFactRelationships, queryKeys } from "../lib/query";

export interface FactDetailRelationship {
  confidence: number;
  createdAt: string | Date;
  explanation: string;
  id: string;
  method: string;
  otherFact?: {
    documentFilename?: string | null;
    entityCanonicalName?: string | null;
    id: string;
    rawValue: string;
    sourcePage: number;
    sourceQuote: string;
    timeScope?: string | null;
  } | null;
  relationType: string;
}

export interface FactDetailData {
  chunk?: {
    positionData?: unknown;
  } | null;
  confidence: number;
  documentFilename: string | null;
  documentId: string;
  entityCanonicalName: string | null;
  entityId: string | null;
  factTypeName: string | null;
  id: string;
  predicate: string;
  rawValue: string;
  relationshipCount?: number;
  sourcePage: number;
  sourceQuote: string;
  timeScope: string | null;
  unit: string | null;
  value: string;
}

function FactPrimaryCard({ fact }: { fact: FactDetailData }) {
  const confidencePct = Math.round((fact.confidence || 1) * 100);

  return (
    <div
      style={{
        background: "var(--card-bg)",
        border: "1px solid var(--border-color)",
        borderRadius: 12,
        padding: "20px 22px",
      }}
    >
      {/* Header badges */}
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
          <code
            style={{
              background: "rgba(255, 255, 255, 0.05)",
              borderRadius: 4,
              color: "var(--accent-olive-light)",
              fontSize: 12,
              fontWeight: 600,
              padding: "3px 8px",
            }}
          >
            {fact.predicate}
          </code>
          {Boolean(fact.factTypeName) && (
            <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
              · {fact.factTypeName}
            </span>
          )}
        </div>
        <span
          className="font-mono"
          style={{
            alignItems: "center",
            background:
              confidencePct >= 90
                ? "var(--accent-green-bg)"
                : "var(--accent-yellow-bg)",
            border: "1px solid rgba(152, 195, 121, 0.25)",
            borderRadius: 12,
            color:
              confidencePct >= 90
                ? "var(--accent-green)"
                : "var(--accent-yellow)",
            display: "inline-flex",
            fontSize: 11,
            fontWeight: 600,
            gap: 4,
            padding: "2px 8px",
          }}
        >
          <ShieldCheck size={12} />
          {confidencePct}% conf
        </span>
      </div>

      {/* Entity Canonical Name */}
      <div style={{ marginBottom: 14 }}>
        <div
          style={{
            alignItems: "center",
            color: "var(--text-dim)",
            display: "flex",
            fontSize: 12,
            gap: 6,
            marginBottom: 2,
          }}
        >
          <Layers size={13} style={{ color: "var(--accent-olive)" }} />
          <span>RESOLVED CANONICAL ENTITY</span>
        </div>
        {fact.entityId ? (
          <Link
            style={{
              color: "var(--text-main)",
              fontSize: 18,
              fontWeight: 700,
              textDecoration: "none",
            }}
            to={`/entities/${fact.entityId}`}
          >
            {fact.entityCanonicalName || "Unknown Entity"}
          </Link>
        ) : (
          <span style={{ fontSize: 18, fontWeight: 700 }}>
            {fact.entityCanonicalName || "Unknown Entity"}
          </span>
        )}
      </div>

      {/* Extracted Value Display */}
      <div
        style={{
          background: "var(--sidebar-bg)",
          border: "1px solid var(--border-subtle)",
          borderRadius: 8,
          marginBottom: 16,
          padding: "14px 16px",
        }}
      >
        <div
          style={{
            color: "var(--text-muted)",
            fontSize: 11,
            letterSpacing: "0.04em",
            marginBottom: 6,
            textTransform: "uppercase",
          }}
        >
          Literal Extracted Value
        </div>
        <div
          className="font-mono"
          style={{
            color: "var(--text-main)",
            fontSize: 22,
            fontWeight: 700,
            letterSpacing: "-0.01em",
          }}
        >
          {fact.rawValue}
        </div>
        {fact.value !== fact.rawValue && (
          <div
            className="font-mono"
            style={{
              color: "var(--text-dim)",
              fontSize: 12,
              marginTop: 4,
            }}
          >
            Normalized value: {fact.value}
          </div>
        )}
      </div>

      {/* Provenance Metadata Pills */}
      <div
        style={{
          borderTop: "1px solid var(--border-subtle)",
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          paddingTop: 14,
        }}
      >
        {Boolean(fact.timeScope) && (
          <div
            style={{
              alignItems: "center",
              color: "var(--text-muted)",
              display: "flex",
              fontSize: 12,
              gap: 6,
            }}
          >
            <Calendar size={13} style={{ color: "var(--accent-olive)" }} />
            <span>
              Time scope:{" "}
              <strong style={{ color: "var(--text-main)" }}>
                {fact.timeScope}
              </strong>
            </span>
          </div>
        )}

        {Boolean(fact.unit) && (
          <div
            style={{
              alignItems: "center",
              color: "var(--text-muted)",
              display: "flex",
              fontSize: 12,
              gap: 6,
            }}
          >
            <Scale size={13} style={{ color: "var(--accent-olive)" }} />
            <span>
              Unit:{" "}
              <strong style={{ color: "var(--text-main)" }}>{fact.unit}</strong>
            </span>
          </div>
        )}

        <div
          style={{
            alignItems: "center",
            color: "var(--text-muted)",
            display: "flex",
            fontSize: 12,
            gap: 6,
          }}
        >
          <CheckCircle size={13} style={{ color: "var(--accent-green)" }} />
          <span>
            Page {fact.sourcePage} in {fact.documentFilename}
          </span>
        </div>
      </div>

      {/* Source Quote Callout Box */}
      <div
        style={{
          background: "rgba(159, 168, 85, 0.05)",
          borderLeft: "3px solid var(--accent-olive)",
          borderRadius: "0 6px 6px 0",
          marginTop: 16,
          padding: "10px 14px",
        }}
      >
        <div
          style={{
            color: "var(--accent-olive-light)",
            fontSize: 11,
            fontWeight: 600,
            letterSpacing: "0.04em",
            marginBottom: 4,
            textTransform: "uppercase",
          }}
        >
          Grounded Source Quote
        </div>
        <blockquote
          className="font-mono"
          style={{
            color: "var(--text-main)",
            fontSize: 13,
            fontStyle: "italic",
            lineHeight: 1.5,
          }}
        >
          &ldquo;{fact.sourceQuote}&rdquo;
        </blockquote>
      </div>
    </div>
  );
}

function FactRelationshipCard({
  rel,
  isHighlighted,
  onNavigate,
}: {
  rel: FactDetailRelationship;
  isHighlighted: boolean;
  onNavigate: (factId: string) => void;
}) {
  const other = rel.otherFact;

  const handleOtherClick = useCallback(() => {
    if (other?.id) {
      onNavigate(other.id);
    }
  }, [other?.id, onNavigate]);

  return (
    <div
      style={{
        background: isHighlighted
          ? "rgba(159, 168, 85, 0.08)"
          : "var(--sidebar-bg)",
        border: isHighlighted
          ? "1px solid var(--accent-olive)"
          : "1px solid var(--border-subtle)",
        borderRadius: 10,
        display: "flex",
        flexDirection: "column",
        gap: 12,
        padding: "16px",
      }}
    >
      {/* Relationship Type & Method */}
      <div
        style={{
          alignItems: "center",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span className={`badge badge-${rel.relationType}`}>
          <span className="badge-dot" />
          {rel.relationType}
        </span>
        <span
          className="font-mono"
          style={{
            color: "var(--text-dim)",
            fontSize: 11,
          }}
        >
          via {rel.method} ({Math.round(rel.confidence * 100)}% conf)
        </span>
      </div>

      {/* Engine Reasoning Box */}
      <div
        style={{
          background: "var(--card-bg)",
          border: "1px solid var(--border-color)",
          borderRadius: 6,
          fontSize: 13,
          lineHeight: 1.5,
          padding: "10px 14px",
        }}
      >
        <strong
          style={{
            color: "var(--accent-olive-light)",
            display: "block",
            fontSize: 11,
            marginBottom: 2,
          }}
        >
          ENGINE REASONING:
        </strong>
        <p style={{ color: "var(--text-main)" }}>{rel.explanation}</p>
      </div>

      {/* Other Fact Preview */}
      {Boolean(other) && (
        <div
          style={{
            alignItems: "center",
            background: "rgba(0,0,0,0.2)",
            borderRadius: 6,
            display: "flex",
            justifyContent: "space-between",
            padding: "10px 12px",
          }}
        >
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: 2,
              minWidth: 0,
            }}
          >
            <div style={{ alignItems: "center", display: "flex", gap: 6 }}>
              <span
                className="font-mono"
                style={{
                  color: "var(--text-main)",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                {other?.rawValue}
              </span>
              {Boolean(other?.timeScope) && (
                <span
                  className="font-mono"
                  style={{ color: "var(--text-dim)", fontSize: 11 }}
                >
                  ({other?.timeScope})
                </span>
              )}
            </div>
            <span
              style={{
                color: "var(--text-muted)",
                fontSize: 11,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              Source: {other?.documentFilename}, p.{other?.sourcePage}
            </span>
          </div>

          <button
            onClick={handleOtherClick}
            style={{
              alignItems: "center",
              background: "var(--card-bg-hover)",
              border: "1px solid var(--border-color)",
              borderRadius: 4,
              color: "var(--text-main)",
              cursor: "pointer",
              display: "inline-flex",
              flexShrink: 0,
              fontSize: 11,
              gap: 4,
              marginLeft: 8,
              padding: "6px 10px",
            }}
            type="button"
          >
            <span>Inspect fact</span>
            <ExternalLink size={11} />
          </button>
        </div>
      )}
    </div>
  );
}

export function FactDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams] = useSearchParams();
  const highlightRelId = searchParams.get("relationshipId");
  const navigate = useNavigate();

  const handleNavigateFact = useCallback(
    (targetId: string) => {
      navigate(`/facts/${targetId}`);
    },
    [navigate]
  );

  const {
    data: factData,
    error: factError,
    isLoading: factLoading,
  } = useQuery({
    enabled: Boolean(id),
    queryFn: () => fetchFact(id as string),
    queryKey: queryKeys.fact(id as string),
  });

  const { data: rawRels = [], isLoading: relsLoading } = useQuery({
    enabled: Boolean(id),
    queryFn: () => fetchFactRelationships(id as string),
    queryKey: queryKeys.factRelationships(id as string),
  });

  const fact = factData as FactDetailData | undefined;
  const relationshipsList = rawRels as FactDetailRelationship[];

  if (factLoading) {
    return (
      <div
        style={{
          color: "var(--text-muted)",
          padding: "60px 40px",
          textAlign: "center",
        }}
      >
        Loading fact details and grounding evidence...
      </div>
    );
  }

  if (factError || !fact) {
    return (
      <div style={{ margin: "60px auto", maxWidth: 700, padding: 24 }}>
        <div
          style={{
            background: "var(--accent-red-bg)",
            border: "1px solid rgba(224, 108, 117, 0.3)",
            borderRadius: 8,
            color: "var(--accent-red)",
            padding: 20,
          }}
        >
          <div
            style={{
              alignItems: "center",
              display: "flex",
              gap: 8,
              marginBottom: 8,
            }}
          >
            <AlertCircle size={18} />
            <h3 style={{ fontSize: 16, fontWeight: 600 }}>Fact not found</h3>
          </div>
          <p style={{ fontSize: 14 }}>
            {factError
              ? (factError as Error).message
              : "The requested fact could not be located."}
          </p>
          <Link
            style={{
              color: "var(--accent-olive-light)",
              display: "inline-block",
              fontSize: 13,
              marginTop: 14,
              textDecoration: "underline",
            }}
            to="/facts"
          >
            ← Return to Facts list
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        minHeight: "100vh",
        padding: "20px 28px",
        width: "100%",
      }}
    >
      {/* Top Breadcrumb Nav */}
      <div style={{ marginBottom: 16 }}>
        <Link
          style={{
            alignItems: "center",
            color: "var(--text-muted)",
            display: "inline-flex",
            fontSize: 13,
            gap: 6,
            transition: "color 0.15s ease",
          }}
          to="/facts"
        >
          <ArrowLeft size={14} />
          <span>Back to all facts</span>
        </Link>
      </div>

      {/* Two-Pane Layout */}
      <div
        style={{
          display: "grid",
          flex: 1,
          gap: 24,
          gridTemplateColumns: "minmax(450px, 1.3fr) minmax(360px, 1fr)",
          minHeight: 0,
        }}
      >
        {/* Left Pane: PDF Viewer with SVG highlighting */}
        <div
          style={{ display: "flex", flexDirection: "column", minHeight: 600 }}
        >
          <PDFViewer
            documentId={fact.documentId}
            filename={fact.documentFilename}
            initialPage={fact.sourcePage}
            positionData={fact.chunk?.positionData}
            sourceQuote={fact.sourceQuote}
          />
        </div>

        {/* Right Pane */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 20,
            overflowY: "auto",
            paddingRight: 4,
          }}
        >
          <FactPrimaryCard fact={fact} />

          {/* Relationships Section */}
          <div
            style={{
              background: "var(--card-bg)",
              border: "1px solid var(--border-color)",
              borderRadius: 12,
              display: "flex",
              flexDirection: "column",
              gap: 16,
              padding: "20px 22px",
            }}
          >
            <div
              style={{
                alignItems: "center",
                borderBottom: "1px solid var(--border-subtle)",
                display: "flex",
                justifyContent: "space-between",
                paddingBottom: 12,
              }}
            >
              <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
                <GitCompare
                  size={16}
                  style={{ color: "var(--accent-olive)" }}
                />
                <h2 style={{ fontSize: 15, fontWeight: 700 }}>
                  Cross-Document Relationships
                </h2>
              </div>
              <span
                style={{
                  background: "var(--sidebar-bg)",
                  borderRadius: 10,
                  color: "var(--text-muted)",
                  fontSize: 12,
                  fontWeight: 600,
                  padding: "2px 8px",
                }}
              >
                {relationshipsList.length}
              </span>
            </div>

            {relsLoading ? (
              <div
                style={{
                  color: "var(--text-muted)",
                  fontSize: 13,
                  padding: 20,
                  textAlign: "center",
                }}
              >
                Loading cross-document links...
              </div>
            ) : relationshipsList.length === 0 ? (
              <div
                style={{
                  alignItems: "center",
                  display: "flex",
                  flexDirection: "column",
                  gap: 8,
                  padding: "30px 16px",
                  textAlign: "center",
                }}
              >
                <GitCompare size={24} style={{ color: "var(--text-dim)" }} />
                <h4 style={{ fontSize: 14, fontWeight: 600 }}>
                  No relationships detected yet
                </h4>
                <p
                  style={{
                    color: "var(--text-muted)",
                    fontSize: 12,
                    maxWidth: 320,
                  }}
                >
                  As additional filings and documents mentioning this entity or
                  predicate are ingested, the reconciliation judge pairs and
                  evaluates corroborations and conflicts.
                </p>
              </div>
            ) : (
              <div
                style={{ display: "flex", flexDirection: "column", gap: 14 }}
              >
                {relationshipsList.map((rel) => (
                  <FactRelationshipCard
                    isHighlighted={highlightRelId === rel.id}
                    key={rel.id}
                    onNavigate={handleNavigateFact}
                    rel={rel}
                  />
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
