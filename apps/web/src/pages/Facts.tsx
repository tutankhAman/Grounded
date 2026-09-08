import { useQuery } from "@tanstack/react-query";
import {
  ChevronLeft,
  ChevronRight,
  Database,
  Filter,
  Search,
  X,
} from "lucide-react";
import type React from "react";
import { useCallback, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { type FactRowItem, FactTable } from "../components/FactTable";
import { fetchFacts, queryKeys } from "../lib/query";

function filterFacts(facts: FactRowItem[], query: string): FactRowItem[] {
  if (!query.trim()) {
    return facts;
  }
  const q = query.toLowerCase().trim();
  return facts.filter(
    (f) =>
      f.predicate.toLowerCase().includes(q) ||
      f.rawValue.toLowerCase().includes(q) ||
      f.sourceQuote.toLowerCase().includes(q) ||
      f.entityCanonicalName?.toLowerCase().includes(q)
  );
}

interface FactsPaginationProps {
  onNext: () => void;
  onPrev: () => void;
  page: number;
  totalPages: number;
}

function FactsPagination({
  page,
  totalPages,
  onPrev,
  onNext,
}: FactsPaginationProps) {
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
          onClick={onPrev}
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
          onClick={onNext}
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

export function FactsPage() {
  const [searchParams, setSearchParams] = useSearchParams();

  const urlDocId = searchParams.get("documentId") || "";
  const urlEntityId = searchParams.get("entityId") || "";
  const urlPredicate = searchParams.get("predicate") || "";

  const [documentId, setDocumentId] = useState(urlDocId);
  const [predicate, setPredicate] = useState(urlPredicate);
  const [entityId, setEntityId] = useState(urlEntityId);
  const [searchQuery, setSearchQuery] = useState("");
  const [page, setPage] = useState(1);
  const limit = 50;

  const queryFilters = useMemo(
    () => ({
      documentId: documentId || undefined,
      entityId: entityId || undefined,
      limit: String(limit),
      page: String(page),
      predicate: predicate || undefined,
    }),
    [documentId, entityId, page, predicate]
  );

  const {
    data: result,
    error,
    isLoading,
  } = useQuery({
    queryFn: () => fetchFacts(queryFilters),
    queryKey: queryKeys.facts(queryFilters),
  });

  const allFacts = (result?.data ?? []) as FactRowItem[];

  // Client-side text filter for instant search responsiveness
  const filteredFacts = useMemo(
    () => filterFacts(allFacts, searchQuery),
    [allFacts, searchQuery]
  );

  const totalCount = result?.pagination.total ?? 0;
  const totalPages = result?.pagination.totalPages ?? 1;

  const hasActiveFilters = Boolean(
    documentId || predicate || entityId || searchQuery
  );

  const clearFilters = useCallback(() => {
    setDocumentId("");
    setPredicate("");
    setEntityId("");
    setSearchQuery("");
    setPage(1);
    setSearchParams({});
  }, [setSearchParams]);

  const handlePredicateChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setPredicate(e.target.value);
      setPage(1);
    },
    []
  );

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearchQuery(e.target.value);
    },
    []
  );

  const handlePrevPage = useCallback(() => {
    setPage((p) => Math.max(1, p - 1));
  }, []);

  const handleNextPage = useCallback(() => {
    setPage((p) => Math.min(totalPages, p + 1));
  }, [totalPages]);

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
          Facts
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 14 }}>
          Browse extracted statements, verified quotes, and cross-document
          grounded knowledge.
        </p>
      </div>

      {/* Filter Bar */}
      <div
        style={{
          alignItems: "center",
          background: "var(--card-bg)",
          border: "1px solid var(--border-color)",
          borderRadius: 8,
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          marginBottom: 20,
          padding: "12px 16px",
        }}
      >
        <div
          style={{
            alignItems: "center",
            color: "var(--text-muted)",
            display: "flex",
            fontSize: 13,
            gap: 6,
          }}
        >
          <Filter size={14} />
          <span>Filters:</span>
        </div>

        {/* Predicate input */}
        <input
          onChange={handlePredicateChange}
          placeholder="Filter by predicate (e.g. revenue)..."
          style={{
            background: "var(--sidebar-bg)",
            border: "1px solid var(--border-color)",
            borderRadius: 6,
            color: "var(--text-main)",
            fontSize: 13,
            padding: "6px 12px",
            width: 220,
          }}
          type="text"
          value={predicate}
        />

        {/* General search */}
        <div
          style={{
            alignItems: "center",
            background: "var(--sidebar-bg)",
            border: "1px solid var(--border-color)",
            borderRadius: 6,
            display: "flex",
            gap: 6,
            padding: "6px 10px",
            width: 240,
          }}
        >
          <Search size={14} style={{ color: "var(--text-dim)" }} />
          <input
            onChange={handleSearchChange}
            placeholder="Search entity, value, quote..."
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
        </div>

        {hasActiveFilters && (
          <button
            onClick={clearFilters}
            style={{
              alignItems: "center",
              background: "transparent",
              border: "1px solid var(--border-color)",
              borderRadius: 6,
              color: "var(--text-muted)",
              cursor: "pointer",
              display: "flex",
              fontSize: 12,
              gap: 4,
              padding: "6px 10px",
            }}
            type="button"
          >
            <X size={13} />
            <span>Reset filters</span>
          </button>
        )}

        <div
          style={{ color: "var(--text-dim)", fontSize: 12, marginLeft: "auto" }}
        >
          {isLoading ? (
            "Loading facts..."
          ) : (
            <span>
              Showing {filteredFacts.length} of {totalCount} facts
            </span>
          )}
        </div>
      </div>

      {/* Facts Table or States */}
      {isLoading ? (
        <div
          style={{
            color: "var(--text-muted)",
            padding: "40px 0",
            textAlign: "center",
          }}
        >
          Loading facts table...
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
          Failed to load facts: {(error as Error).message}
        </div>
      ) : filteredFacts.length === 0 ? (
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
            padding: "50px 20px",
            textAlign: "center",
          }}
        >
          <Database size={24} style={{ color: "var(--text-dim)" }} />
          <div>
            <h3 style={{ fontSize: 15, fontWeight: 600, marginBottom: 4 }}>
              No facts match your search criteria
            </h3>
            <p style={{ color: "var(--text-muted)", fontSize: 13 }}>
              {hasActiveFilters
                ? "Try clearing filters to see all extracted facts."
                : "Upload and process documents to populate the facts table."}
            </p>
          </div>
          {hasActiveFilters && (
            <button
              onClick={clearFilters}
              style={{
                background: "var(--card-bg-hover)",
                border: "1px solid var(--border-color)",
                borderRadius: 6,
                color: "var(--text-main)",
                cursor: "pointer",
                fontSize: 12,
                padding: "6px 14px",
              }}
              type="button"
            >
              Clear filters
            </button>
          )}
        </div>
      ) : (
        <>
          <FactTable facts={filteredFacts} />

          {/* Pagination Controls */}
          <FactsPagination
            onNext={handleNextPage}
            onPrev={handlePrevPage}
            page={page}
            totalPages={totalPages}
          />
        </>
      )}
    </div>
  );
}
