import { useQuery } from "@tanstack/react-query";
import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Database,
  Layers,
  Search,
  Tag,
  X,
} from "lucide-react";
import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { fetchEntities, fetchEntity, queryKeys } from "../lib/query";

export interface EntityItem {
  aliasCount: number;
  canonicalName: string;
  contextSample: string | null;
  createdAt: string | Date;
  entityType: string | null;
  factCount: number;
  id: string;
}

export interface AliasItem {
  alias: string;
  createdAt: string | Date;
  documentFilename: string | null;
  documentId: string | null;
  id: string;
}

function EntityAliasesList({
  aliases,
  isLoading,
}: {
  aliases?: AliasItem[];
  isLoading: boolean;
}) {
  if (isLoading) {
    return (
      <div style={{ color: "var(--text-dim)", fontSize: 12 }}>
        Loading aliases...
      </div>
    );
  }

  if (!aliases || aliases.length === 0) {
    return (
      <div style={{ color: "var(--text-dim)", fontSize: 12 }}>
        No alternative surface forms recorded for this entity.
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {aliases.map((alias) => (
        <div
          key={alias.id}
          style={{
            alignItems: "center",
            display: "flex",
            fontSize: 13,
            gap: 8,
            padding: "4px 0",
          }}
        >
          <span style={{ color: "var(--text-dim)" }}>aka:</span>
          <span
            className="font-mono"
            style={{
              background: "rgba(26, 29, 33, 0.05)",
              borderRadius: 4,
              color: "var(--text-main)",
              fontSize: 12,
              fontWeight: 600,
              padding: "2px 8px",
            }}
          >
            &ldquo;{alias.alias}&rdquo;
          </span>
          {Boolean(alias.documentFilename) && (
            <span style={{ color: "var(--text-muted)", fontSize: 12 }}>
              ({alias.documentFilename})
            </span>
          )}
        </div>
      ))}
    </div>
  );
}

function EntityCard({ entity }: { entity: EntityItem }) {
  const [expanded, setExpanded] = useState(false);

  const { data: details, isLoading } = useQuery({
    enabled: expanded,
    queryFn: () => fetchEntity(entity.id),
    queryKey: queryKeys.entity(entity.id),
  });

  const toggleExpanded = useCallback(() => {
    setExpanded((v) => !v);
  }, []);

  return (
    <div
      style={{
        background: "var(--card-bg)",
        border: "1px solid var(--border-color)",
        borderRadius: 12,
        display: "flex",
        flexDirection: "column",
        gap: 14,
        padding: "20px 22px",
        transition: "border-color 0.15s ease",
      }}
    >
      {/* Header Row */}
      <div
        style={{
          alignItems: "flex-start",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
            <Layers
              size={18}
              style={{ color: "var(--accent-olive)", flexShrink: 0 }}
            />
            <h3
              style={{
                fontSize: 17,
                fontWeight: 700,
                letterSpacing: "-0.01em",
              }}
            >
              {entity.canonicalName}
            </h3>
            {Boolean(entity.entityType) && (
              <span
                style={{
                  background: "var(--sidebar-bg)",
                  border: "1px solid var(--border-color)",
                  borderRadius: 6,
                  color: "var(--text-muted)",
                  fontSize: 11,
                  fontWeight: 600,
                  padding: "2px 8px",
                  textTransform: "uppercase",
                }}
              >
                {entity.entityType}
              </span>
            )}
          </div>

          {Boolean(entity.contextSample) && (
            <p
              style={{
                color: "var(--text-dim)",
                fontSize: 13,
                fontStyle: "italic",
                maxWidth: 640,
              }}
            >
              &ldquo;{entity.contextSample}&rdquo;
            </p>
          )}
        </div>

        {/* Action badges */}
        <div style={{ alignItems: "center", display: "flex", gap: 10 }}>
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
              textDecoration: "none",
            }}
            to={`/facts?entityId=${entity.id}`}
          >
            <Database size={13} style={{ color: "var(--accent-olive)" }} />
            <span>{entity.factCount} facts</span>
          </Link>

          <button
            onClick={toggleExpanded}
            style={{
              alignItems: "center",
              background: expanded
                ? "var(--accent-olive-bg)"
                : "var(--sidebar-bg)",
              border: "1px solid var(--border-color)",
              borderRadius: 6,
              color: expanded
                ? "var(--accent-olive-light)"
                : "var(--text-muted)",
              cursor: "pointer",
              display: "inline-flex",
              fontSize: 12,
              fontWeight: 500,
              gap: 6,
              padding: "6px 12px",
            }}
            type="button"
          >
            <Tag size={13} />
            <span>{entity.aliasCount} aliases</span>
            {expanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
          </button>
        </div>
      </div>

      {/* Expanded Aliases List */}
      {Boolean(expanded) && (
        <div
          style={{
            background: "var(--sidebar-bg)",
            border: "1px solid var(--border-subtle)",
            borderRadius: 8,
            marginTop: 4,
            padding: "14px 16px",
          }}
        >
          <div
            style={{
              color: "var(--accent-olive-light)",
              fontSize: 11,
              fontWeight: 600,
              letterSpacing: "0.04em",
              marginBottom: 8,
              textTransform: "uppercase",
            }}
          >
            Resolved Aliases & Surface Forms
          </div>

          <EntityAliasesList
            aliases={details?.aliases as AliasItem[] | undefined}
            isLoading={isLoading}
          />
        </div>
      )}
    </div>
  );
}

function EntitiesPagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
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
        Page {page} of {totalPages}
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

export function EntitiesPage() {
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const limit = 20;

  const queryFilters = {
    limit: String(limit),
    page: String(page),
    search: searchQuery.trim() || undefined,
  };

  const {
    data: result,
    error,
    isLoading,
  } = useQuery({
    queryFn: () => fetchEntities(queryFilters),
    queryKey: queryKeys.entities(queryFilters),
  });

  const entities = (result?.data ?? []) as EntityItem[];
  const totalCount = result?.pagination.total ?? 0;
  const totalPages = result?.pagination.totalPages ?? 1;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value);
      setPage(1);
    },
    []
  );

  const clearSearch = useCallback(() => {
    setSearchQuery("");
  }, []);

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
          Canonical Entities
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
          Browse resolved cluster entities, deduplicated canonical forms, and
          cross-document surface aliases.
        </p>
      </div>

      {/* Search Filter Bar */}
      <div
        style={{
          alignItems: "center",
          background: "var(--card-bg)",
          border: "1px solid var(--border-color)",
          borderRadius: 8,
          display: "flex",
          gap: 12,
          marginBottom: 20,
          padding: "12px 16px",
        }}
      >
        <div
          style={{
            alignItems: "center",
            background: "var(--sidebar-bg)",
            border: "1px solid var(--border-color)",
            borderRadius: 6,
            display: "flex",
            flex: 1,
            gap: 8,
            maxWidth: 360,
            padding: "8px 12px",
          }}
        >
          <Search size={14} style={{ color: "var(--text-dim)" }} />
          <input
            onChange={handleSearchChange}
            placeholder="Search canonical name..."
            style={{
              background: "transparent",
              border: "none",
              color: "var(--text-main)",
              fontSize: 13,
              outline: "none",
              width: "100%",
            }}
            type="text"
            value={searchQuery}
          />
          {Boolean(searchQuery) && (
            <button
              onClick={clearSearch}
              style={{
                background: "transparent",
                border: "none",
                color: "var(--text-dim)",
                cursor: "pointer",
                padding: 0,
              }}
              type="button"
            >
              <X size={13} />
            </button>
          )}
        </div>

        <div
          style={{ color: "var(--text-dim)", fontSize: 12, marginLeft: "auto" }}
        >
          {isLoading ? (
            "Loading entities..."
          ) : (
            <span>
              {totalCount} canonical {totalCount === 1 ? "entity" : "entities"}{" "}
              found
            </span>
          )}
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
          Loading entities...
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
          Failed to load entities: {(error as Error).message}
        </div>
      ) : entities.length === 0 ? (
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
          <Layers size={28} style={{ color: "var(--text-dim)" }} />
          <div>
            <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 4 }}>
              No canonical entities found
            </h3>
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
              {searchQuery
                ? `No entities matching "${searchQuery}".`
                : "Upload documents to trigger entity resolution and alias discovery."}
            </p>
          </div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          {entities.map((ent) => (
            <EntityCard entity={ent} key={ent.id} />
          ))}

          <EntitiesPagination
            onPageChange={setPage}
            page={page}
            totalPages={totalPages}
          />
        </div>
      )}
    </div>
  );
}
