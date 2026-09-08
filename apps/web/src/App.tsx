import { useEffect, useState } from 'react';
import { api } from './lib/api';

interface HealthData {
  status: string;
  pg: boolean;
  redis: boolean;
  timestamp: string;
}

export function App() {
  const [health, setHealth] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const checkHealth = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.health.get();
      if (res.data) {
        setHealth(res.data as HealthData);
      } else {
        setError(res.error ? JSON.stringify(res.error) : 'Failed to retrieve health status');
      }
    } catch (err: any) {
      setError(err.message || 'Error connecting to API');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    checkHealth();
    const interval = setInterval(checkHealth, 5000);
    return () => clearInterval(interval);
  }, []);

  return (
    <div style={{ maxWidth: 840, margin: '60px auto', padding: '0 24px' }}>
      <header style={{ marginBottom: 40, borderBottom: '1px solid var(--border-color)', paddingBottom: 24 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700, letterSpacing: '-0.02em', marginBottom: 8 }}>
          Grounded — Fact Knowledge Layer
        </h1>
        <p style={{ color: 'var(--text-muted)', fontSize: 15 }}>
          Cross-document grounding, entity resolution, and factual reconciliation engine.
        </p>
      </header>

      <div style={{
        background: 'var(--card-bg)',
        border: '1px solid var(--border-color)',
        borderRadius: 12,
        padding: 24,
        marginBottom: 32
      }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
          <h2 style={{ fontSize: 18, fontWeight: 600 }}>System Status (Phase 0)</h2>
          <button
            onClick={checkHealth}
            disabled={loading}
            style={{
              padding: '6px 14px',
              fontSize: 13,
              borderRadius: 6,
              background: '#242831',
              color: '#fff',
              border: 'none',
              cursor: 'pointer'
            }}
          >
            {loading ? 'Checking...' : 'Refresh'}
          </button>
        </div>

        {error ? (
          <div style={{
            padding: 16,
            borderRadius: 8,
            background: 'rgba(224, 108, 117, 0.1)',
            border: '1px solid var(--accent-red)',
            color: 'var(--accent-red)',
            fontSize: 14,
            fontFamily: 'var(--font-mono)'
          }}>
            API Connection Error: {error}
          </div>
        ) : health ? (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 16 }}>
            <div style={{
              background: '#1d212a',
              padding: 16,
              borderRadius: 8,
              border: '1px solid var(--border-color)'
            }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>API STATUS</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: health.status === 'ok' ? 'var(--accent-green)' : 'var(--accent-red)'
                }} />
                <span style={{ fontWeight: 600 }}>{health.status.toUpperCase()}</span>
              </div>
            </div>

            <div style={{
              background: '#1d212a',
              padding: 16,
              borderRadius: 8,
              border: '1px solid var(--border-color)'
            }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>POSTGRESQL + PGVECTOR</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: health.pg ? 'var(--accent-green)' : 'var(--accent-red)'
                }} />
                <span style={{ fontWeight: 600 }}>{health.pg ? 'CONNECTED' : 'DISCONNECTED'}</span>
              </div>
            </div>

            <div style={{
              background: '#1d212a',
              padding: 16,
              borderRadius: 8,
              border: '1px solid var(--border-color)'
            }}>
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 6 }}>REDIS QUEUE</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 10,
                  height: 10,
                  borderRadius: '50%',
                  background: health.redis ? 'var(--accent-green)' : 'var(--accent-red)'
                }} />
                <span style={{ fontWeight: 600 }}>{health.redis ? 'CONNECTED' : 'DISCONNECTED'}</span>
              </div>
            </div>
          </div>
        ) : (
          <p style={{ color: 'var(--text-muted)' }}>Waiting for status check...</p>
        )}
      </div>

      <div style={{
        background: 'var(--card-bg)',
        border: '1px solid var(--border-color)',
        borderRadius: 12,
        padding: 24,
      }}>
        <h3 style={{ fontSize: 16, fontWeight: 600, marginBottom: 12 }}>Scaffolded Modules:</h3>
        <ul style={{ listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8, fontSize: 14 }}>
          <li>🟢 <code style={{ color: 'var(--accent-olive-light)' }}>apps/api</code> — Elysia HTTP & WebSockets runtime</li>
          <li>🟢 <code style={{ color: 'var(--accent-olive-light)' }}>apps/worker</code> — BullMQ background queue consumer</li>
          <li>🟢 <code style={{ color: 'var(--accent-olive-light)' }}>apps/web</code> — Vite + React 19 Frontend</li>
          <li>🟢 <code style={{ color: 'var(--accent-olive-light)' }}>packages/db</code> — Drizzle ORM + pgvector vector schema & migrations</li>
        </ul>
      </div>
    </div>
  );
}

export default App;
