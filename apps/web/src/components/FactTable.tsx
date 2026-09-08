import { ArrowRight, GitCompare, Layers } from "lucide-react";
import { useCallback } from "react";
import { useNavigate } from "react-router-dom";

export interface FactRowItem {
  confidence: number;
  currency: string | null;
  documentFilename: string | null;
  documentId: string;
  entityCanonicalName: string | null;
  entityId: string | null;
  extractedAt: string | Date;
  id: string;
  predicate: string;
  qualifiers: unknown;
  rawValue: string;
  relationshipCount?: number;
  sourceChunkIndex: number;
  sourcePage: number;
  sourceQuote: string;
  timeScope: string | null;
  unit: string | null;
  value: string;
}

interface FactTableRowProps {
  fact: FactRowItem;
  onRowClick: (id: string) => void;
}

function FactTableRow({ fact, onRowClick }: FactTableRowProps) {
  const handleClick = useCallback(() => {
    onRowClick(fact.id);
  }, [fact.id, onRowClick]);

  const relCount = fact.relationshipCount ?? 0;
  const confPct = Math.round((fact.confidence || 1.0) * 100);

  return (
    <tr
      className="table-row-hover"
      onClick={handleClick}
      style={{
        borderBottom: "1px solid var(--border-subtle)",
      }}
    >
      {/* Entity */}
      <td style={{ fontWeight: 600, padding: "14px 18px" }}>
        <div style={{ alignItems: "center", display: "flex", gap: 6 }}>
          <Layers
            size={13}
            style={{ color: "var(--accent-olive)", flexShrink: 0 }}
          />
          <span>{fact.entityCanonicalName || "—"}</span>
        </div>
      </td>

      {/* Predicate */}
      <td style={{ padding: "14px 18px" }}>
        <code
          style={{
            background: "rgba(255, 255, 255, 0.04)",
            borderRadius: 4,
            color: "var(--accent-olive-light)",
            fontSize: 12,
            padding: "3px 6px",
          }}
        >
          {fact.predicate}
        </code>
      </td>

      {/* Extracted Value */}
      <td style={{ padding: "14px 18px" }}>
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <span
            className="font-mono"
            style={{
              color: "var(--text-main)",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {fact.rawValue}
          </span>
          {Boolean(fact.timeScope) && (
            <span
              className="font-mono"
              style={{
                color: "var(--text-dim)",
                fontSize: 11,
              }}
            >
              {fact.timeScope}
            </span>
          )}
        </div>
      </td>

      {/* Relationships / Sources */}
      <td style={{ padding: "14px 18px" }}>
        {relCount > 0 ? (
          <span
            style={{
              alignItems: "center",
              background: "var(--accent-olive-bg)",
              border: "1px solid rgba(159, 168, 85, 0.3)",
              borderRadius: 12,
              color: "var(--accent-olive-light)",
              display: "inline-flex",
              fontSize: 11,
              fontWeight: 600,
              gap: 5,
              padding: "3px 8px",
            }}
          >
            <GitCompare size={12} />
            <span>
              {relCount + 1} sources ({relCount} rels)
            </span>
          </span>
        ) : (
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
            1 source
          </span>
        )}
      </td>

      {/* Confidence */}
      <td style={{ padding: "14px 18px" }}>
        <span
          className="font-mono"
          style={{
            color:
              confPct >= 90
                ? "var(--accent-green)"
                : confPct >= 75
                  ? "var(--accent-yellow)"
                  : "var(--accent-red)",
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          {confPct}%
        </span>
      </td>

      {/* Source Document */}
      <td
        style={{
          color: "var(--text-muted)",
          fontSize: 12,
          padding: "14px 18px",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <span
            style={{
              maxWidth: 180,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
            title={fact.documentFilename || ""}
          >
            {fact.documentFilename || "Document"}
          </span>
          <span style={{ color: "var(--text-dim)", fontSize: 11 }}>
            Page {fact.sourcePage}
          </span>
        </div>
      </td>

      {/* Action arrow */}
      <td style={{ padding: "14px 18px", textAlign: "right" }}>
        <ArrowRight size={14} style={{ color: "var(--text-dim)" }} />
      </td>
    </tr>
  );
}

interface FactTableProps {
  facts: FactRowItem[];
}

export function FactTable({ facts }: FactTableProps) {
  const navigate = useNavigate();

  const handleRowClick = useCallback(
    (id: string) => {
      navigate(`/facts/${id}`);
    },
    [navigate]
  );

  return (
    <div
      style={{
        background: "var(--card-bg)",
        border: "1px solid var(--border-color)",
        borderRadius: 10,
        overflow: "hidden",
        width: "100%",
      }}
    >
      <div style={{ overflowX: "auto" }}>
        <table
          style={{
            borderCollapse: "collapse",
            fontSize: 13,
            textAlign: "left",
            width: "100%",
          }}
        >
          <thead>
            <tr
              style={{
                background: "var(--sidebar-bg)",
                borderBottom: "1px solid var(--border-color)",
                color: "var(--text-muted)",
                fontSize: 11,
                fontWeight: 600,
                letterSpacing: "0.04em",
                textTransform: "uppercase",
              }}
            >
              <th style={{ padding: "12px 18px" }}>Entity</th>
              <th style={{ padding: "12px 18px" }}>Predicate</th>
              <th style={{ padding: "12px 18px" }}>Extracted Value</th>
              <th style={{ padding: "12px 18px" }}>Relationships</th>
              <th style={{ padding: "12px 18px" }}>Confidence</th>
              <th style={{ padding: "12px 18px" }}>Source Document</th>
              <th style={{ padding: "12px 18px", width: 40 }} />
            </tr>
          </thead>
          <tbody>
            {facts.map((fact) => (
              <FactTableRow
                fact={fact}
                key={fact.id}
                onRowClick={handleRowClick}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
