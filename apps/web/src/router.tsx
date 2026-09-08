import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import {
  Link,
  Navigate,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import { fetchRelationship, queryKeys } from "./lib/query";
import { DocumentsPage } from "./pages/Documents";
import { EntitiesPage } from "./pages/Entities";
import { FactDetailPage } from "./pages/FactDetail";
import { FactsPage } from "./pages/Facts";
import { OverviewPage } from "./pages/Overview";
import { RelationshipsPage } from "./pages/Relationships";

// Helper component to resolve deep links to /relationships/:id
function RelationshipRouteResolver() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const {
    data: rel,
    error,
    isLoading,
  } = useQuery({
    enabled: Boolean(id),
    queryFn: () => fetchRelationship(id as string),
    queryKey: queryKeys.relationship(id as string),
  });

  useEffect(() => {
    if (
      rel &&
      "factA" in rel &&
      rel.factA &&
      typeof rel.factA === "object" &&
      "id" in rel.factA
    ) {
      navigate(
        `/facts/${(rel.factA as { id: string }).id}?relationshipId=${id}`,
        {
          replace: true,
        }
      );
    }
  }, [rel, id, navigate]);

  if (isLoading) {
    return (
      <div
        style={{
          color: "var(--text-muted)",
          padding: "60px 40px",
          textAlign: "center",
        }}
      >
        Loading relationship details...
      </div>
    );
  }

  if (error || !rel) {
    return (
      <div style={{ margin: "60px auto", maxWidth: 600, padding: 20 }}>
        <p style={{ color: "var(--accent-red)", marginBottom: 12 }}>
          Relationship could not be found.
        </p>
        <Link
          style={{
            color: "var(--accent-olive-light)",
            fontSize: 13,
            textDecoration: "underline",
          }}
          to="/relationships"
        >
          ← Return to relationships list
        </Link>
      </div>
    );
  }

  return (
    <div
      style={{
        color: "var(--text-muted)",
        padding: "60px 40px",
        textAlign: "center",
      }}
    >
      Redirecting to grounded evidence viewer...
    </div>
  );
}

export function AppRouter() {
  return (
    <Routes>
      <Route element={<OverviewPage />} path="/" />
      <Route element={<DocumentsPage />} path="/documents" />
      <Route element={<FactsPage />} path="/facts" />
      <Route element={<FactDetailPage />} path="/facts/:id" />
      <Route element={<RelationshipsPage />} path="/relationships" />
      <Route
        element={<RelationshipRouteResolver />}
        path="/relationships/:id"
      />
      <Route element={<EntitiesPage />} path="/entities" />
      <Route element={<Navigate replace to="/facts" />} path="/entities/:id" />
      <Route element={<Navigate replace to="/" />} path="*" />
    </Routes>
  );
}
