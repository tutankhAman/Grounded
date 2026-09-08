import { useCallback, useEffect, useState } from "react";
import { api } from "./lib/api";

interface HealthData {
  pg: boolean;
  redis: boolean;
  status: string;
  timestamp: string;
}

export function App() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const checkHealth = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.health.get();
      if (res.data) {
        setHealth(res.data as HealthData);
      } else {
        setError(
          res.error
            ? JSON.stringify(res.error)
            : "Failed to retrieve health status"
        );
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Error connecting to API");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 5000);
    return () => clearInterval(interval);
  }, [checkHealth]);

  return (
    <div style={{ margin: "60px auto", maxWidth: 840, padding: "0 24px" }}>
      <header
        style={{
          borderBottom: "1px solid var(--border-color)",
          marginBottom: 40,
          paddingBottom: 24,
        }}
      >
        <h1
          style={{
            fontSize: 28,
            fontWeight: 700,
            letterSpacing: "-0.02em",
            marginBottom: 8,
          }}
        >
          Grounded — Fact Knowledge Layer
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: 15 }}>
          Cross-document grounding, entity resolution, and factual
          reconciliation engine.
        </p>
      </header>

      <div
        style={{
          background: "var(--card-bg)",
          border: "1px solid var(--border-color)",
          borderRadius: 12,
          marginBottom: 32,
          padding: 24,
        }}
      >
        <div
          style={{
            alignItems: "center",
            display: "flex",
            justifyContent: "space-between",
            marginBottom: 20,
          }}
        >
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>
            System Status (Phase 0)
          </h2>
          <button
            disabled={loading}
            onClick={checkHealth}
            style={{
              background: "#242831",
              border: "none",
              borderRadius: 6,
              color: "#fff",
              cursor: "pointer",
              fontSize: 13,
              padding: "6px 14px",
            }}
            type="button"
          >
            {loading ? "Checking..." : "Refresh"}
          </button>
        </div>

        {error ? (
          <div
            style={{
              background: "rgba(224, 108, 117, 0.1)",
              border: "1px solid var(--accent-red)",
              borderRadius: 8,
              color: "var(--accent-red)",
              fontFamily: "var(--font-mono)",
              fontSize: 14,
              padding: 16,
            }}
          >
            API Connection Error: {error}
          </div>
        ) : health ? (
          <div
            style={{
              display: "grid",
              gap: 16,
              gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
            }}
          >
            <div
              style={{
                background: "#1d212a",
                border: "1px solid var(--border-color)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div
                style={{
                  color: "var(--text-muted)",
                  fontSize: 12,
                  marginBottom: 6,
                }}
              >
                API STATUS
              </div>
              <div style={{ alignItems: "center", display: "flex", gap: 8 }}>
                <span
                  style={{
                    background:
                      health.status === "ok"
                        ? "var(--accent-green)"
                        : "var(--accent-red)",
                    borderRadius: "50%",
                    height: 10,
                    width: 10,
                  }}
                />
                <span style={{ fontWeight: 600 }}>
                  {health.status.toUpperCase()}
                </span>
              </div>
            </div>

            <div
              style={{
                background: "#1d212a",
                border: "1px solid var(--border-color)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div
                style={{
                  color: "var(--text-muted)",
                  fontSize: 12,
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
                    height: 10,
                    width: 10,
                  }}
                />
                <span style={{ fontWeight: 600 }}>
                  {health.pg ? "CONNECTED" : "DISCONNECTED"}
                </span>
              </div>
            </div>

            <div
              style={{
                background: "#1d212a",
                border: "1px solid var(--border-color)",
                borderRadius: 8,
                padding: 16,
              }}
            >
              <div
                style={{
                  color: "var(--text-muted)",
                  fontSize: 12,
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
                    height: 10,
                    width: 10,
                  }}
                />
                <span style={{ fontWeight: 600 }}>
                  {health.redis ? "CONNECTED" : "DISCONNECTED"}
                </span>
              </div>
            </div>
          </div>
        ) : (
          <p style={{ color: "var(--text-muted)" }}>
            Waiting for status check...
          </p>
        )}
      </div>

      <div
        style={{
          background: "var(--card-bg)",
          border: "1px solid var(--border-color)",
          borderRadius: 12,
          padding: 24,
        }}
      >
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>
          Scaffolded Modules:
        </h3>
        <ul
          style={{
            display: "flex",
            flexDirection: "column",
            fontSize: 14,
            gap: 8,
            listStyle: "none",
          }}
        >
          <li>
            🟢{" "}
            <code style={{ color: "var(--accent-olive-light)" }}>apps/api</code>{" "}
            — Elysia HTTP & WebSockets runtime
          </li>
          <li>
            🟢{" "}
            <code style={{ color: "var(--accent-olive-light)" }}>
              apps/worker
            </code>{" "}
            — BullMQ background queue consumer
          </li>
          <li>
            🟢{" "}
            <code style={{ color: "var(--accent-olive-light)" }}>apps/web</code>{" "}
            — Vite + React 19 Frontend
          </li>
          <li>
            🟢{" "}
            <code style={{ color: "var(--accent-olive-light)" }}>
              packages/db
            </code>{" "}
            — Drizzle ORM + pgvector vector schema & migrations
          </li>
        </ul>
      </div>
    </div>
  );
}
