import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  CheckCircle2,
  Database,
  FileText,
  GitCompare,
  HelpCircle,
  Layers,
  RefreshCw,
  Sparkles,
  XCircle,
} from "lucide-react";
import { useCallback } from "react";
import { Link } from "react-router-dom";
import demoHighlightsData from "../data/demoHighlights.json";
import { api } from "../lib/api";
import {
  fetchDocuments,
  fetchEntities,
  fetchFacts,
  fetchRelationships,
  queryKeys,
} from "../lib/query";

interface HealthData {
  pg: boolean;
  redis: boolean;
  status: string;
  timestamp: string;
}

export function OverviewPage() {
  // Metrics Queries
  const { data: docs = [] } = useQuery({
    queryFn: fetchDocuments,
    queryKey: queryKeys.documents(),
  });

  const { data: factsResult } = useQuery({
    queryFn: () => fetchFacts({ limit: "1" }),
    queryKey: queryKeys.facts({ limit: "1" }),
  });

  const { data: relsResult } = useQuery({
    queryFn: () => fetchRelationships({ limit: "1" }),
    queryKey: queryKeys.relationships({ limit: "1" }),
  });

  const { data: entitiesResult } = useQuery({
    queryFn: () => fetchEntities({ limit: "1" }),
    queryKey: queryKeys.entities({ limit: "1" }),
  });

  // Health Query (preserved from Phase 0)
  const {
    data: health,
    isFetching: healthLoading,
    refetch: refetchHealth,
  } = useQuery<HealthData | null>({
    queryFn: async () => {
      const res = await api.health.get();
      return (res.data as HealthData) || null;
    },
    queryKey: queryKeys.health,
    refetchInterval: 10_000,
  });

  const handleRefreshHealth = useCallback(() => {
    refetchHealth();
  }, [refetchHealth]);

  const totalDocs = docs.length;
  const totalFacts = factsResult?.pagination.total ?? 0;
  const totalRels = relsResult?.pagination.total ?? 0;
  const totalEntities = entitiesResult?.pagination.total ?? 0;

  const highlights = [
    {
      bg: "var(--accent-green-bg)",
      color: "var(--accent-green)",
      description: demoHighlightsData.corroboration.description,
      fallbackUrl: "/relationships?type=corroborates",
      icon: CheckCircle2,
      id: demoHighlightsData.corroboration.relationshipId,
      key: "corroboration",
      targetType: "relationship",
      title: "Corroborated fact",
    },
    {
      bg: "var(--accent-red-bg)",
      color: "var(--accent-red)",
      description: demoHighlightsData.contradiction.description,
      fallbackUrl: "/relationships?type=contradicts",
      icon: XCircle,
      id: demoHighlightsData.contradiction.relationshipId,
      key: "contradiction",
      targetType: "relationship",
      title: "Contradiction / Conflict",
    },
    {
      bg: "var(--accent-blue-bg)",
      color: "var(--accent-blue)",
      description: demoHighlightsData.reconciled.description,
      fallbackUrl: "/relationships?type=reconciled",
      icon: HelpCircle,
      id: demoHighlightsData.reconciled.relationshipId,
      key: "reconciled",
      targetType: "relationship",
      title: "Context-explained conflict",
    },
    {
      bg: "var(--accent-yellow-bg)",
      color: "var(--accent-yellow)",
      description: demoHighlightsData.failure.description,
      fallbackUrl: "/facts",
      icon: AlertTriangle,
      id: demoHighlightsData.failure.factId,
      key: "failure",
      targetType: "fact",
      title: "Known extraction failure",
    },
  ];

  return (
    <div style={{ maxWidth: 1100, padding: "32px 36px", width: "100%" }}>
      {/* Header */}
      <div
        style={{
          borderBottom: "1px solid var(--border-color)",
          marginBottom: 28,
          paddingBottom: 22,
        }}
      >
        <h1
          style={{
            fontSize: 26,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            marginBottom: 6,
          }}
        >
          Fact Knowledge Layer
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
          Cross-document grounding, entity resolution, and factual
          reconciliation engine.
        </p>
      </div>

      {/* Top Metrics Row */}
      <div
        style={{
          display: "grid",
          gap: 16,
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          marginBottom: 32,
        }}
      >
        {/* Metric 1: Documents */}
        <Link
          style={{
            background: "var(--card-bg)",
            border: "1px solid var(--border-color)",
            borderRadius: 10,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "18px 20px",
            transition: "all 0.15s ease",
          }}
          to="/documents"
        >
          <div
            style={{
              alignItems: "center",
              color: "var(--text-muted)",
              display: "flex",
              fontSize: 12,
              fontWeight: 600,
              gap: 8,
            }}
          >
            <FileText size={15} style={{ color: "var(--accent-olive)" }} />
            <span>DOCUMENTS</span>
          </div>
          <span
            className="font-mono"
            style={{ color: "var(--text-main)", fontSize: 26, fontWeight: 700 }}
          >
            {totalDocs}
          </span>
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
            Ingested filings & reports
          </span>
        </Link>

        {/* Metric 2: Facts */}
        <Link
          style={{
            background: "var(--card-bg)",
            border: "1px solid var(--border-color)",
            borderRadius: 10,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "18px 20px",
            transition: "all 0.15s ease",
          }}
          to="/facts"
        >
          <div
            style={{
              alignItems: "center",
              color: "var(--text-muted)",
              display: "flex",
              fontSize: 12,
              fontWeight: 600,
              gap: 8,
            }}
          >
            <Database size={15} style={{ color: "var(--accent-olive)" }} />
            <span>FACTS</span>
          </div>
          <span
            className="font-mono"
            style={{ color: "var(--text-main)", fontSize: 26, fontWeight: 700 }}
          >
            {totalFacts}
          </span>
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
            Extracted grounded claims
          </span>
        </Link>

        {/* Metric 3: Relationships */}
        <Link
          style={{
            background: "var(--card-bg)",
            border: "1px solid var(--border-color)",
            borderRadius: 10,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "18px 20px",
            transition: "all 0.15s ease",
          }}
          to="/relationships"
        >
          <div
            style={{
              alignItems: "center",
              color: "var(--text-muted)",
              display: "flex",
              fontSize: 12,
              fontWeight: 600,
              gap: 8,
            }}
          >
            <GitCompare size={15} style={{ color: "var(--accent-olive)" }} />
            <span>RELATIONSHIPS</span>
          </div>
          <span
            className="font-mono"
            style={{ color: "var(--text-main)", fontSize: 26, fontWeight: 700 }}
          >
            {totalRels}
          </span>
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
            Cross-document comparisons
          </span>
        </Link>

        {/* Metric 4: Entities */}
        <Link
          style={{
            background: "var(--card-bg)",
            border: "1px solid var(--border-color)",
            borderRadius: 10,
            display: "flex",
            flexDirection: "column",
            gap: 6,
            padding: "18px 20px",
            transition: "all 0.15s ease",
          }}
          to="/entities"
        >
          <div
            style={{
              alignItems: "center",
              color: "var(--text-muted)",
              display: "flex",
              fontSize: 12,
              fontWeight: 600,
              gap: 8,
            }}
          >
            <Layers size={15} style={{ color: "var(--accent-olive)" }} />
            <span>CANONICAL ENTITIES</span>
          </div>
          <span
            className="font-mono"
            style={{ color: "var(--text-main)", fontSize: 26, fontWeight: 700 }}
          >
            {totalEntities}
          </span>
          <span style={{ color: "var(--text-dim)", fontSize: 12 }}>
            Resolved entity clusters
          </span>
        </Link>
      </div>

      {/* Demo Highlights Section (The Highest-Leverage Reviewer Panel) */}
      <div
        style={{
          background: "var(--card-bg)",
          border: "1px solid var(--border-color)",
          borderRadius: 12,
          marginBottom: 32,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            alignItems: "center",
            background: "var(--sidebar-bg)",
            borderBottom: "1px solid var(--border-color)",
            display: "flex",
            justifyContent: "space-between",
            padding: "16px 22px",
          }}
        >
          <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
            <Sparkles size={16} style={{ color: "var(--accent-olive)" }} />
            <h2 style={{ fontSize: 16, fontWeight: 700 }}>Demo Highlights</h2>
          </div>
          <span
            style={{
              background: "rgba(159, 168, 85, 0.12)",
              borderRadius: 12,
              color: "var(--accent-olive-light)",
              fontSize: 11,
              fontWeight: 600,
              padding: "3px 10px",
            }}
          >
            Curated 1-Click Verification
          </span>
        </div>

        <div style={{ display: "flex", flexDirection: "column" }}>
          {highlights.map((item, index) => {
            const Icon = item.icon;
            const hasPinnedId = Boolean(item.id && item.id.trim().length > 0);
            const targetUrl = hasPinnedId
              ? item.targetType === "fact"
                ? `/facts/${item.id}`
                : `/relationships/${item.id}`
              : item.fallbackUrl;

            return (
              <div
                key={item.key}
                style={{
                  alignItems: "center",
                  borderBottom:
                    index < highlights.length - 1
                      ? "1px solid var(--border-subtle)"
                      : "none",
                  display: "flex",
                  justifyContent: "space-between",
                  padding: "16px 22px",
                  transition: "background 0.15s ease",
                }}
              >
                <div
                  style={{
                    alignItems: "center",
                    display: "flex",
                    gap: 14,
                    minWidth: 0,
                  }}
                >
                  <div
                    style={{
                      alignItems: "center",
                      background: item.bg,
                      borderRadius: 8,
                      display: "flex",
                      height: 36,
                      justifyContent: "center",
                      width: 36,
                    }}
                  >
                    <Icon size={18} style={{ color: item.color }} />
                  </div>
                  <div>
                    <h3
                      style={{ fontSize: 14, fontWeight: 600, marginBottom: 2 }}
                    >
                      {item.title}
                    </h3>
                    <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
                      {item.description}
                    </p>
                  </div>
                </div>

                <div>
                  <Link
                    style={{
                      alignItems: "center",
                      background: hasPinnedId
                        ? "var(--accent-olive)"
                        : "var(--card-bg-hover)",
                      border: hasPinnedId
                        ? "none"
                        : "1px solid var(--border-color)",
                      borderRadius: 6,
                      color: hasPinnedId ? "#0d0e11" : "var(--text-main)",
                      display: "inline-flex",
                      fontSize: 12,
                      fontWeight: 600,
                      gap: 6,
                      padding: "8px 14px",
                      textDecoration: "none",
                      transition: "all 0.15s ease",
                    }}
                    to={targetUrl}
                  >
                    <span>
                      {hasPinnedId ? "View pinned case" : "Explore cases"}
                    </span>
                    <ArrowRight size={13} />
                  </Link>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* System Status Dashboard (Preserved from Phase 0) */}
      <div
        style={{
          background: "var(--card-bg)",
          border: "1px solid var(--border-color)",
          borderRadius: 12,
          padding: "20px 22px",
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 16,
          }}
        >
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 2 }}>
              System & Infrastructure Status
            </h3>
            <p style={{ color: "var(--text-muted)", fontSize: 12 }}>
              Runtime connectivity for Elysia HTTP/WS, PostgreSQL + pgvector,
              and Redis BullMQ queues.
            </p>
          </div>

          <button
            disabled={healthLoading}
            onClick={handleRefreshHealth}
            style={{
              alignItems: "center",
              background: "var(--sidebar-bg)",
              border: "1px solid var(--border-color)",
              borderRadius: 6,
              color: "var(--text-muted)",
              cursor: healthLoading ? "not-allowed" : "pointer",
              display: "inline-flex",
              fontSize: 12,
              gap: 6,
              padding: "6px 12px",
            }}
            type="button"
          >
            <RefreshCw
              className={healthLoading ? "animate-spin" : ""}
              size={12}
            />
            <span>{healthLoading ? "Checking..." : "Refresh"}</span>
          </button>
        </div>

        {health ? (
          <div
            style={{
              display: "grid",
              gap: 12,
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            }}
          >
            {/* API STATUS */}
            <div
              style={{
                background: "var(--sidebar-bg)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 8,
                padding: 14,
              }}
            >
              <div
                style={{
                  color: "var(--text-dim)",
                  fontSize: 11,
                  fontWeight: 600,
                  marginBottom: 6,
                }}
              >
                API RUNTIME
              </div>
              <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
                <span
                  style={{
                    background:
                      health.status === "ok"
                        ? "var(--accent-green)"
                        : "var(--accent-red)",
                    borderRadius: "50%",
                    height: 8,
                    width: 8,
                  }}
                />
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {health.status.toUpperCase()}
                </span>
              </div>
            </div>

            {/* POSTGRESQL */}
            <div
              style={{
                background: "var(--sidebar-bg)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 8,
                padding: 14,
              }}
            >
              <div
                style={{
                  color: "var(--text-dim)",
                  fontSize: 11,
                  fontWeight: 600,
                  marginBottom: 6,
                }}
              >
                POSTGRESQL + PGVECTOR
              </div>
              <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
                <span
                  style={{
                    background: health.pg
                      ? "var(--accent-green)"
                      : "var(--accent-red)",
                    borderRadius: "50%",
                    height: 8,
                    width: 8,
                  }}
                />
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {health.pg ? "CONNECTED" : "DISCONNECTED"}
                </span>
              </div>
            </div>

            {/* REDIS QUEUE */}
            <div
              style={{
                background: "var(--sidebar-bg)",
                border: "1px solid var(--border-subtle)",
                borderRadius: 8,
                padding: 14,
              }}
            >
              <div
                style={{
                  color: "var(--text-dim)",
                  fontSize: 11,
                  fontWeight: 600,
                  marginBottom: 6,
                }}
              >
                REDIS QUEUE
              </div>
              <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
                <span
                  style={{
                    background: health.redis
                      ? "var(--accent-green)"
                      : "var(--accent-red)",
                    borderRadius: "50%",
                    height: 8,
                    width: 8,
                  }}
                />
                <span style={{ fontSize: 13, fontWeight: 600 }}>
                  {health.redis ? "CONNECTED" : "DISCONNECTED"}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <div style={{ color: "var(--text-muted)", fontSize: 13 }}>
            Connecting to system health services...
          </div>
        )}
      </div>
    </div>
  );
}
