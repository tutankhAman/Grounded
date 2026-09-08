# Grounded — Fact Knowledge Layer

A high-performance cross-document fact extraction, grounding, and reconciliation engine built with TypeScript, Bun, Elysia, PostgreSQL (`pgvector`), Redis (`BullMQ`), and React.

## Prerequisites

- **[Bun](https://bun.sh/)** (v1.1+ or v1.4+)
- **[Docker](https://www.docker.com/)** and **Docker Compose**

## Quickstart

### 1. Start Infrastructure (PostgreSQL with pgvector & Redis)
```bash
docker compose up -d
```

### 2. Install Dependencies
```bash
bun install
```

### 3. Run Database Migrations
```bash
bun run db:migrate
```

### 4. Start Development Servers
```bash
bun run dev
```
This runs all services concurrently:
- **API (`apps/api`)**: http://localhost:3000
- **Health Check**: http://localhost:3000/health
- **Worker (`apps/worker`)**: BullMQ background processing
- **Web App (`apps/web`)**: http://localhost:5173

---

## Workspace Structure

```
grounded/
├── apps/
│   ├── api/       # Elysia HTTP & WebSocket server
│   ├── worker/    # BullMQ worker (parsing, LLM extraction, reconciliation)
│   └── web/       # Vite + React 19 Frontend (Eden Treaty + TanStack Query)
├── packages/
│   └── db/        # Drizzle ORM schema, pgvector vector column, migrations
├── docker-compose.yml
├── .env.example
└── package.json
```
