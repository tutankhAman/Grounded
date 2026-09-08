# Fact Knowledge Layer — Phasewise Development Plan

Companion to `architecture.md`. This is the execution breakdown: exactly what to build, in what order,
and precisely how you know each phase is done. Fully TypeScript / Bun stack throughout.

Timeline tags:
- **Core** — required for a working, gradeable submission. Do not cut.
- **Should-have** — cheap relative to their value; cut only under real time pressure.
- **Stretch** — attempt only once everything above is solid and demo'd.

---

## Phase 0 — Scaffolding [Core]

### Repository layout

```
grounded/
├── apps/
│   ├── api/              # Elysia on Bun — HTTP + WebSocket server
│   │   ├── src/
│   │   │   ├── index.ts          # Elysia app bootstrap, plugin mounts
│   │   │   ├── routes/
│   │   │   │   ├── documents.ts  # POST /documents, WS /documents/:id/status
│   │   │   │   ├── facts.ts      # GET /facts, GET /facts/:id, GET /facts/:id/relationships
│   │   │   │   └── entities.ts   # GET /entities/:id
│   │   │   ├── plugins/
│   │   │   │   └── db.ts         # Drizzle client singleton, injected via Elysia .decorate()
│   │   │   └── lib/
│   │   │       └── queue.ts      # BullMQ producer helpers
│   │   └── package.json
│   │
│   ├── worker/           # BullMQ consumers — same Bun runtime, separate process
│   │   ├── src/
│   │   │   ├── index.ts           # Worker bootstrap, registers all consumers
│   │   │   ├── consumers/
│   │   │   │   ├── parse.ts       # PDF parse job consumer
│   │   │   │   ├── extract.ts     # Fact extraction job consumer
│   │   │   │   ├── resolve.ts     # Entity resolution job consumer
│   │   │   │   └── reconcile.ts   # Matching + reconciliation job consumer
│   │   │   └── pipeline/
│   │   │       ├── parser.ts      # pdfjs-dist text + position extraction
│   │   │       ├── extractor.ts   # Vercel AI SDK generateObject calls
│   │   │       ├── resolver.ts    # Entity resolution logic
│   │   │       ├── matcher.ts     # pgvector nearest-neighbor fact matching
│   │   │       └── reconciler.ts  # Rule pre-filter + LLM judge
│   │   └── package.json
│   │
│   └── web/              # Vite + React + React Router
│       ├── src/
│       │   ├── main.tsx
│       │   ├── router.tsx
│       │   ├── lib/
│       │   │   ├── api.ts         # Eden Treaty client instance
│       │   │   └── query.ts       # TanStack Query client + keys
│       │   ├── pages/
│       │   │   ├── Overview.tsx
│       │   │   ├── Documents.tsx
│       │   │   ├── Facts.tsx
│       │   │   ├── FactDetail.tsx
│       │   │   ├── Relationships.tsx
│       │   │   └── Entities.tsx
│       │   └── components/
│       │       ├── Sidebar.tsx
│       │       ├── PDFViewer.tsx       # pdfjs-dist canvas + highlight overlay
│       │       ├── FactTable.tsx       # TanStack Table wrapper
│       │       ├── RelationshipCard.tsx
│       │       └── UploadButton.tsx    # File picker + multipart POST
│       └── package.json
│
├── packages/
│   └── db/               # Shared Drizzle schema + migrations
│       ├── src/
│       │   ├── schema.ts          # All table definitions
│       │   ├── client.ts          # Drizzle client factory
│       │   └── migrations/        # drizzle-kit output
│       └── package.json
│
├── docker-compose.yml
├── .env.example
└── package.json          # Bun workspace root
```

### Infrastructure

**`docker-compose.yml`** must bring up two services only:

```yaml
services:
  postgres:
    image: pgvector/pgvector:pg16
    environment:
      POSTGRES_DB: grounded
      POSTGRES_USER: grounded
      POSTGRES_PASSWORD: grounded
    ports: ["5432:5432"]
    volumes: ["pgdata:/var/lib/postgresql/data"]

  redis:
    image: redis:7-alpine
    ports: ["6379:6379"]

volumes:
  pgdata:
```

Use the `pgvector/pgvector` image directly — it ships with the extension pre-installed. Do not use a
bare Postgres image and try to install the extension at runtime; it fails silently in some
environments and is a reviewer-unfriendly failure mode.

### Drizzle setup

The `CREATE EXTENSION IF NOT EXISTS vector;` statement must run before any other migration.
`drizzle-kit` does not generate this automatically. Create a hand-written first migration file:

```sql
-- 0000_enable_vector.sql
CREATE EXTENSION IF NOT EXISTS vector;
```

Then run `drizzle-kit generate` for the schema migrations. The migration runner must guarantee
`0000_enable_vector.sql` executes first; if using `drizzle-kit migrate`, number your files so it sorts
before the auto-generated ones.

### Environment

`.env.example` must document every key:

```
DATABASE_URL=postgresql://grounded:grounded@localhost:5432/grounded
REDIS_URL=redis://localhost:6379
GROQ_API_KEY=
GEMINI_API_KEY=
PORT=3000
UPLOAD_DIR=./uploads
EMBEDDING_MODEL=gemini-embedding-2        # Google Gemini Embedding 2
EMBEDDING_DIM=1536                        # Matryoshka Representation Learning (MRL) output dimensionality to stay within pgvector HNSW limits (< 2000)
FACT_TYPE_SIMILARITY_THRESHOLD=0.85        # cosine similarity above which predicates are considered the same type
ENTITY_MATCH_THRESHOLD=0.80
```

Declare a constant `EMBEDDING_DIM` (defaulting to 1536 via Gemini MRL) and reference it everywhere instead of hard-coding 1536.
Never treat matching `EMBEDDING_DIM` values as sufficient for comparing vectors across different models; cosine similarity
across distinct embedding spaces is meaningless. When `EMBEDDING_MODEL` changes, enforce a migration strategy: either
re-embed all existing `entities`, `fact_types`, and `facts` vector columns via a migration job, or isolate vectors by model
version before permitting similarity queries.

### Health check

`GET /health` must verify all three dependencies, not just return 200:

```typescript
// routes/health.ts
app.get('/health', async ({ db, redis }) => {
  const [pgOk, redisOk] = await Promise.all([
    db.execute(sql`SELECT 1`).then(() => true).catch(() => false),
    redis.ping().then(r => r === 'PONG').catch(() => false),
  ]);
  const status = pgOk && redisOk ? 200 : 503;
  return new Response(JSON.stringify({ pg: pgOk, redis: redisOk }), { status });
});
```

### Exit criteria

`docker-compose up -d && bun install && bun run dev` on a clean clone:
1. Postgres and Redis containers are running.
2. Drizzle migrations have applied (including the vector extension).
3. `GET /health` returns `{ pg: true, redis: true }` with HTTP 200.
4. Worker process starts and logs "worker ready".

---

## Phase 1 — Ingestion and Parsing [Core]

### Upload endpoint

`POST /documents` accepts `multipart/form-data` with a single `file` field:

```typescript
app.post('/documents', async ({ body, db, queue }) => {
  const { file } = body;                  // Elysia parses multipart automatically
  const filename = file.name;

  // Stream to disk — never buffer the whole PDF via arrayBuffer(), large PDFs would
  // OOM the API process that also serves WS status.
  const filePath = path.join(process.env.UPLOAD_DIR, `${crypto.randomUUID()}.pdf`);
  await Bun.write(filePath, file.stream());   // constant memory; clean up partial file on throw

  const [doc] = await db.insert(documents).values({
    filename,
    filePath,
    status: 'pending',
    uploadedAt: new Date(),
  }).returning();

  await queue.add('parse', { documentId: doc.id, filePath });

  return { id: doc.id, status: 'pending' };
}, {
  body: t.Object({ file: t.File({ type: 'application/pdf' }) }),
});
```

Return immediately after enqueuing. Never await the parse job from the HTTP handler.
Enforce a max upload size and delete the partial file if the stream throws.

### Parser module (`pipeline/parser.ts`)

Uses `pdfjs-dist` in a Node/Bun worker context (no canvas required for text extraction).
Parsing is a lazy sequential stream: one page in memory at a time, persisted immediately.
`getDocument` still holds the source bytes (PDF xref trailer lives at EOF), so laziness is
processing-level, not I/O-level. Never `Promise.all()` pages.

```typescript
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

export interface TextRun {
  pageNumber: number;
  text: string;
  x: number; y: number; width: number; height: number;
  fontName: string;
}

export interface PageChunk {
  pageNumber: number;
  runs: TextRun[];
  rawText: string;          // concatenated, for LLM input
  isTableHeavy: boolean;
  imageDataUrl?: string;    // populated only if isTableHeavy
}
```

**Per-page extraction**: iterate pages sequentially with `getPage(i)`, collect each item's `str`,
`transform[4]` (x), `transform[5]` (y), `width`, `height` from `getTextContent()`. Group into
`TextRun[]` for that page only, persist the `page_chunks` row immediately, then call
`page.cleanup()` before advancing. Wrap each page in try/catch: on failure emit a
`pipeline_events` warning with `{ pageNumber }` and continue instead of failing the document.
Upsert on `(document_id, page_number, chunk_index)` so a crashed job resumes without duplicates.
Store only trimmed run fields (`text`, x, y, width, height, `fontName`) in `position_data`,
not raw pdfjs item objects.

```typescript
export async function* streamPages(documentId: string, filePath: string): AsyncGenerator<PageChunk> {
  const data = new Uint8Array(await Bun.file(filePath).arrayBuffer()); // source bytes stay resident
  const pdf = await pdfjs.getDocument({ data }).promise;
  try {
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      try {
        yield await extractPage(documentId, page, i);   // text + heuristic + optional render
      } finally {
        page.cleanup();
      }
    }
  } finally {
    await pdf.destroy();
  }
}
// Consumer: for await (const chunk of streamPages(...)) { persist; publish progress; enqueue extract }
```

**Table-heavy heuristic**: a page is flagged if:
- More than 40% of its text items are purely numeric (regex `/^[\d,.$%\-]+$/`), **and**
- The average text-item width is less than 25% of page width (short columns)

**Low-text / chart-slide fallback**: a page is also flagged for vision rendering if `rawText.length < ~1000`
chars or text-item count < N (tune N against the earnings deck — sampled slides run 479–1287 chars vs
3000–8000 for report pages). Chart slides keep figures in vector graphics with almost no extractable
text, so the numeric-density heuristic never fires there; without this fallback they would go down the
text path with nothing to extract. Vision-flagged pages set `imagePath`; quote validation is skipped
for vision-only facts with no source text (flagged via `sourceQuoteValid = false`, not dropped).

Tune all three thresholds against the starter PDFs (Delhivery + India-macroeconomy excerpts), not before.

**Image rendering for table pages**: use `pdfjs-dist`'s canvas API for vision-flagged pages only
(table-heavy OR low-text/chart-slide fallback).
In Bun this requires the `canvas` npm package — test rendering before writing the rest of Phase 1.
Render at 2x device pixel ratio so table text is legible for the vision model, persist the image,
then immediately release memory (zero the canvas, drop refs, `page.cleanup()`):

```typescript
import { createCanvas } from 'canvas';

async function renderPageToDataUrl(page: PDFPageProxy, scale = 2): Promise<string> {
  const viewport = page.getViewport({ scale });
  const canvas = createCanvas(viewport.width, viewport.height);
  try {
    const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
    await page.render({ canvasContext: ctx, viewport }).promise;
    return canvas.toDataURL('image/png');
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
}
```

**Chunking strategy**: one chunk = one page. Do not use fixed token windows — evidence spans need
to map back to real page coordinates, and page-boundary chunking keeps that mapping trivial. If a
single page exceeds ~6000 tokens (uncommon), split on paragraph gaps (runs with a vertical gap >
1.5× median line height) and emit multiple chunks for that page, each tagged with `{ pageNumber,
chunkIndex }`.

**Persistence**: insert each `page_chunks` row as its page is parsed (inside the stream loop),
not batched at the end — this is what keeps memory O(1 page) and makes progress reporting honest:

```sql
page_chunks(
  id, document_id, page_number, chunk_index,   -- page_number = PDF index (1-based position in file), drives the viewer
  raw_text, is_table_heavy,
  image_path,       -- null unless vision-flagged (table-heavy or low-text fallback)
  position_data jsonb,  -- array of TextRun objects, kept for frontend highlight mapping
  token_estimate int,
  created_at
)
```

**Printed vs PDF page numbers**: the starter excerpts retain non-contiguous originals, so numbers
printed on the page jump (e.g. 1, 4, 26–37…). `page_number`/`sourcePage` always mean PDF index.
If the extractor reads a printed number in-text, store it as `qualifiers.printedPage` — never
overwrite `sourcePage` with it. Note the jump in the README/demo so reviewers aren't confused.

Store `position_data` as JSONB now. The frontend PDF viewer reads it back to draw highlight
overlays later. Do not reconstruct position data from `pdfjs-dist` a second time on the frontend.

**Status updates**: update `documents.status` to `'parsing'` when the job starts, `'parsed'` when
done, `'failed'` with an error message on exception. Publish per-page progress to
`doc:${documentId}:status` inside the stream loop (`{ status: 'parsing', progress: { current: i,
total: numPages } }`), fire-and-forget — never await WS delivery from the worker. The API
forwards these over the WebSocket (see Phase 5).

### Exit criteria

1. Upload any PDF via `POST /documents`.
2. A debug endpoint (`GET /documents/:id/chunks`) returns page-level chunks.
3. Table-heavy AND low-text/chart-slide pages include a rendered image path; dense text-only pages do not.
4. Position data in `page_chunks.position_data` contains real x/y/width/height, not zeros.
5. `documents.status` is `'parsed'` on completion.

---

## Phase 2 — Fact Extraction [Core]

### Zod schema

Define once, import everywhere. Lives in `packages/db/src/extractionSchema.ts`:

```typescript
import { z } from 'zod';

export const ExtractedFactSchema = z.object({
  entity: z.object({
    name: z.string(),
    type: z.string(),    // "organization", "person", "place", "product" — model infers, no enum
    context: z.string(), // one sentence of surrounding context that makes the entity unambiguous
  }),
  predicate: z.string(),       // e.g. "annual_revenue", "director_status" — model coins these
  value: z.string(),           // normalized where possible
  rawValue: z.string(),        // verbatim as stated
  unit: z.string().optional(),
  currency: z.string().optional(),
  timeScope: z.string().optional(),  // fiscal year, date, period
  qualifiers: z.record(z.string()).optional(),  // {"geography": "India", "segment": "SaaS"} etc.
  sourceQuote: z.string(),     // verbatim sentence(s) from the source chunk
  confidence: z.number().min(0).max(1),
  factTypeDescription: z.string(), // model's description of what kind of fact this is
});

export const ExtractionResultSchema = z.object({
  facts: z.array(ExtractedFactSchema),
});

export type ExtractedFact = z.infer<typeof ExtractedFactSchema>;
```

### System prompt

Craft this once and iterate. Key constraints:
- Tell the model to extract only facts that are **stated**, not implied or computed.
- Require `sourceQuote` to be an **exact substring** of the provided chunk text (say this explicitly).
- Tell the model to invent `predicate` names as snake_case and to be consistent within a document.
- Tell the model `factTypeDescription` should be a one-sentence description usable to classify
  similar facts in other documents (this feeds the dynamic schema).
- Tell the model to set `confidence < 0.7` if the fact comes from a table it cannot fully read,
  or if there is ambiguity in scope.

```
You are a precise fact extractor. Your only job is to identify and extract discrete factual
claims from the provided document chunk.

Rules:
1. Extract only facts that are explicitly stated, not inferred.
2. sourceQuote must be an exact, verbatim substring of the chunk text — copy-paste, do not paraphrase.
3. predicate should be a snake_case label describing the relationship (e.g. "annual_revenue", "employee_count").
4. factTypeDescription should describe the category of fact in one sentence, generalizable to other documents.
5. Set confidence below 0.7 if the fact comes from a table whose layout you cannot fully interpret,
   or if the scope (time, geography, segment) is ambiguous.
6. If a chunk contains no extractable facts, return {"facts": []}.
```

### LLM calls

Use Vercel AI SDK `generateObject`. Two paths, same schema:

**Text chunk path (Groq):**
```typescript
import { generateObject } from 'ai';
import { createGroq } from '@ai-sdk/groq';

const groq = createGroq({ apiKey: process.env.GROQ_API_KEY });

const { object } = await generateObject({
  model: groq('llama-3.3-70b-versatile'),
  schema: ExtractionResultSchema,
  system: EXTRACTION_SYSTEM_PROMPT,
  prompt: `Extract facts from this document chunk:\n\n${chunk.rawText}`,
  maxRetries: 2,
});
```

**Table-page path (Gemini vision):**
```typescript
import { createGoogleGenerativeAI } from '@ai-sdk/google';

const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });

const { object } = await generateObject({
  model: google('gemini-2.0-flash'),   // confirm structured output support before committing to this model
  schema: ExtractionResultSchema,
  system: EXTRACTION_SYSTEM_PROMPT,
  messages: [{
    role: 'user',
    content: [
      { type: 'image', image: chunk.imageDataUrl },
      { type: 'text', text: 'Extract all facts visible in this table.' },
    ],
  }],
  maxRetries: 2,
});
```

**Fallback for structured output failures**: wrap the call in a try/catch. If `generateObject`
throws a schema validation error, fall back to a raw `generateText` call and attempt
`JSON.parse` + `ExtractionResultSchema.safeParse()`. If that also fails, mark the chunk
`status = 'extraction_failed'` and log the raw model output for the Phase 8 failure hunt.

### Quote validation

After extraction, for each fact:

```typescript
function validateQuote(fact: ExtractedFact, sourceText: string): boolean {
  return sourceText.includes(fact.sourceQuote.trim());
}
```

If this fails: set `fact.confidence *= 0.5` and tag it with `{ quoteMismatch: true }` in
`qualifiers`. Do not silently drop it — a flagged, lower-confidence fact is more useful than a
silently discarded one, and it becomes a candidate for the Phase 8 failure case.
Vision-only facts from low-text/chart-slide pages have no source text to match against: skip the
string check, keep `sourceQuoteValid = false` with `{ visionOnly: true }`, and keep the fact.

### Embedding

After validation, generate an embedding for each fact's predicate + value + entity name (one
concatenated string). Use Google's `gemini-embedding-2` via the Vercel AI SDK `@ai-sdk/google`
`embed()` / `embedMany()` helper. With `outputDimensionality: 1536` (via Matryoshka Representation
Learning), we maintain standard float4 pgvector HNSW index compatibility (< 2000 dims limit)
and retain >98% retrieval performance while halving storage. Never mix models in the same
vector column, or cosine similarity becomes meaningless across rows.

```typescript
import { embed, embedMany } from 'ai';
import { createGoogleGenerativeAI, type GoogleEmbeddingModelOptions } from '@ai-sdk/google';

const google = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY });

const { embedding } = await embed({
  model: google.embedding(process.env.EMBEDDING_MODEL ?? 'gemini-embedding-2'),
  value: `${fact.entity.name} ${fact.predicate} ${fact.value}`,
  providerOptions: {
    google: {
      outputDimensionality: Number(process.env.EMBEDDING_DIM ?? 1536),
    } satisfies GoogleEmbeddingModelOptions,
  },
});
```

Batch embed where possible via `embedMany` (max 100 per call for Gemini `:batchEmbedContents`).
Do not embed one fact at a time in a loop. Note: `gemini-embedding-2` dropped explicit `taskType`
parameters (which were supported in `gemini-embedding-001`); task-specific guidance or framing is
included in the text content prefix if needed (e.g., `fact: ...` or `entity: ...`).

### `fact_types` canonicalization

For each new `factTypeDescription`:

1. Embed it.
2. Query: `SELECT id, name FROM fact_types ORDER BY embedding <=> $1 LIMIT 1`.
3. If cosine similarity > `FACT_TYPE_SIMILARITY_THRESHOLD` (default 0.85): link to existing type.
4. Else: insert a new `fact_types` row with `name` set to the predicate, `description` set to the
   model's description, and `examplePredicates` as a JSONB array starting with the current predicate.

Track which predicates get canonicalized to existing types vs. minting new ones. This data shows
up directly in the dynamic schema demonstration (Phase 10).

### Persistence

```typescript
await db.insert(facts).values({
  documentId: chunk.documentId,
  entityId: null,              // filled in Phase 3
  factTypeId: resolvedTypeId,
  predicate: fact.predicate,
  value: fact.value,
  rawValue: fact.rawValue,
  unit: fact.unit,
  currency: fact.currency,
  timeScope: fact.timeScope,
  qualifiers: fact.qualifiers ?? {},
  embedding: embedding,
  confidence: fact.confidence,
  sourcePage: chunk.pageNumber,
  sourceQuote: fact.sourceQuote,
  sourceQuoteValid: quoteIsValid,
  extractedAt: new Date(),
});
```

### Exit criteria

1. Upload one starter PDF. `GET /facts?documentId=<id>` returns facts.
2. Every fact has a non-empty `sourceQuote`.
3. For a randomly sampled fact, the `sourceQuote` is verifiably present in the source PDF text.
4. Facts that failed quote validation are flagged (`sourceQuoteValid = false`), not silently dropped.
5. `fact_types` table has at least one row per document.

---

## Phase 3 — Entity Resolution [Core]

This is the step most submissions skip. Build it deliberately.

### Within-document resolution

For each document, collect all `entity.name` strings from the extraction pass. Two surface forms
refer to the same entity if:

1. **String similarity ≥ 0.85** (Levenshtein / Jaro-Winkler — use the `fastest-levenshtein`
   package; roll your own only if it's a one-liner): covers "Acme Corp" vs. "Acme Corp." and
   abbreviations.
2. **Embedding cosine similarity ≥ `ENTITY_MATCH_THRESHOLD`**: covers paraphrases and aliases
   ("the Company", "the Issuer") that string distance would miss.

Group surface forms into clusters. Elect the most frequent (or longest specific) surface form as
the canonical name.

### Across-document resolution

For each newly extracted entity, after within-document clustering:

1. Embed the canonical name + context sentence.
2. Query: `SELECT id, canonicalName FROM entities ORDER BY embedding <=> $1 LIMIT 5`.
3. For each candidate with cosine similarity > `ENTITY_MATCH_THRESHOLD`:
   - Make an LLM call (small, cheap — Groq `llama-3.1-8b-instant` is sufficient here):
     ```
     Are these two entities the same real-world entity?
     Entity A: "{name}" — context: "{context}"
     Entity B: "{canonicalName}" — context: "{existingContext}"
     Answer YES or NO with one sentence of reasoning.
     ```
   - If YES: link to existing entity, insert an alias row.
   - If NO: create a new entity.

**Do not trust embedding distance alone** for cross-document resolution. "Apple Inc." and "Apple
Records" can embed close to each other. The lightweight LLM confirm call is cheap (< 50 tokens)
and catches false merges that would otherwise corrupt the reconciliation step.

### Schema additions for Phase 3

The `entities` table should also store `contextSample` (a short text excerpt from the document
where this entity was first mentioned) so future across-document comparisons have real context to
pass to the LLM confirmation call.

### Back-fill fact links

After entity resolution, update `facts.entityId` for all facts in the document just processed.

### Exit criteria

1. Process two starter PDFs. The same organization (e.g., "Acme Corp" / "Acme Corporation") resolves
   to one `entities` row, with both surface forms as aliases.
2. Different entities with similar names (e.g. "Apple Inc." vs. "Apple Records") remain distinct.
3. Every fact in `facts` has a non-null `entityId`.
4. `entity_aliases` is populated with the surface forms found in each document.

---

## Phase 4 — Matching and Reconciliation [Core]

This phase produces required cases 1–3.

### Fact matching

For each new fact, run a nearest-neighbor search over facts from *other* documents sharing the same
resolved entity:

```typescript
const candidates = await db
  .select()
  .from(facts)
  .where(
    and(
      eq(facts.entityId, newFact.entityId),
      not(eq(facts.documentId, newFact.documentId)),
      sql`${facts.embedding} <=> ${newFact.embedding} < 0.35`,  // distance threshold, tune after testing
    )
  )
  .orderBy(sql`${facts.embedding} <=> ${newFact.embedding}`)
  .limit(10);
```

The `<=>` operator is pgvector cosine distance (0 = identical, 2 = opposite). Threshold of 0.35
on cosine distance ≈ 0.65 similarity — tune this against real results.

For performance, add a pgvector index after Phase 9's stress test:
```sql
CREATE INDEX ON facts USING hnsw (embedding vector_cosine_ops)
WITH (m = 16, ef_construction = 64);
```

Do not add the index in Phase 4 — it slows inserts and the dataset is too small for it to matter yet.

### Rule-based pre-filter

For each `(newFact, candidate)` pair, run deterministic checks first:

| Check | Logic | Result |
|---|---|---|
| Exact value match | `normalize(fact.value) === normalize(candidate.value)` | → `corroborates` |
| Unit mismatch, convertible | e.g. `$4.2M` vs `4200000` — apply conversion, compare | → `corroborates` if equal after conversion |
| Time scope differs | Both have `timeScope`, they differ and values differ | → `reconciled` (temporal scope explains it) |
| Currency differs, same amount | Same value, different currencies | → `reconciled` (explicit in explanation) |
| Value differs, same time scope | No qualifier explains it | → escalate to LLM judge |
| Missing scope on either | Cannot rule out a scope difference | → escalate to LLM judge |

Only escalate to the LLM judge when the rule filter cannot cleanly resolve the relationship.
This keeps costs low and makes the rule layer a genuine first-pass, not a bottleneck.

### LLM judge (Gemini)

```typescript
const { object } = await generateObject({
  model: google('gemini-2.0-pro'),     // stronger reasoning here, fewer calls
  schema: z.object({
    relationType: z.enum(['corroborates', 'contradicts', 'reconciled', 'uncertain']),
    explanation: z.string(),           // plain-language reasoning, surfaces in the UI
    confidence: z.number().min(0).max(1),
  }),
  system: `You are a fact reconciliation judge. Given two facts about the same entity from
different documents, determine their relationship and explain it in plain language.`,
  prompt: `
Fact A: ${JSON.stringify(factA)}
Source A: "${factA.sourceQuote}" (${docA.filename}, page ${factA.sourcePage})

Fact B: ${JSON.stringify(factB)}
Source B: "${factB.sourceQuote}" (${docB.filename}, page ${factB.sourcePage})

Classify the relationship and explain it. Focus on qualifiers, time scope, and units
when explaining apparent contradictions.
`,
});
```

**Key**: the `explanation` field is the deliverable. A bare `relationType` label is meaningless
to a reviewer; the explanation is what demonstrates the system actually reasoned about the
relationship.

### Persistence

```typescript
await db.insert(relationships).values({
  factAId: newFact.id,
  factBId: candidate.id,
  relationType: result.relationType,
  explanation: result.explanation,
  confidence: result.confidence,
  method: ruleResolved ? 'rule' : 'llm_judge',
  createdAt: new Date(),
});
```

### Avoiding duplicate relationships

Before inserting, check that no relationship row already exists for `(factAId, factBId)` or
`(factBId, factAId)` — matching runs per-document incrementally, so the same pair can be
evaluated from both sides.

### Exit criteria

Run all three starter PDFs through the full pipeline, then manually confirm:
1. At least one `relationType = 'corroborates'` row where `rawValue` differs textually between
   the two facts (proves it isn't just an exact string match).
2. At least one `relationType = 'contradicts'` row with confidence > 0.8 and no qualifier
   difference that would explain it.
3. At least one `relationType = 'reconciled'` row where the explanation explicitly names a
   qualifying difference (different fiscal year, different currency, different scope) and the
   raw values look contradictory at first glance.
4. Every relationship has a non-empty `explanation` string, not just a label.

---

## Phase 5 — API Layer [Core]

### Endpoints

Implement exactly what the UI needs — nothing more. Every endpoint must be typed end-to-end
via Eden Treaty. Define types in the route handler and the client picks them up automatically.

```typescript
// GET /facts
app.get('/facts', async ({ query, db }) => {
  const { entityId, predicate, documentId, page = '1', limit = '50' } = query;
  // Build Drizzle where clause from optional filters
  // Return { facts, total, page, limit }
}, {
  query: t.Object({
    entityId:   t.Optional(t.String()),
    predicate:  t.Optional(t.String()),
    documentId: t.Optional(t.String()),
    page:       t.Optional(t.String()),
    limit:      t.Optional(t.String()),
  }),
});

// GET /facts/:id
app.get('/facts/:id', async ({ params, db }) => {
  // Return fact + its source chunk's position_data for the PDF highlight overlay
});

// GET /facts/:id/relationships
app.get('/facts/:id/relationships', async ({ params, db }) => {
  // Return all relationships where factAId = id OR factBId = id,
  // joining the other fact + its document details
});

// GET /entities/:id
app.get('/entities/:id', async ({ params, db }) => {
  // Return entity + all aliases + all facts (paginated)
});

// WS /documents/:id/status
app.ws('/documents/:id/status', {
  open(ws) { /* subscribe to Redis pub/sub channel for this document */ },
  close(ws) { /* unsubscribe */ },
});
```

### WebSocket status updates

The worker publishes per-page progress plus stage transitions to a Redis pub/sub channel,
fire-and-forget (never await WS delivery from the worker):
```typescript
await redis.publish(`doc:${documentId}:status`, JSON.stringify({
  status: 'parsing' | 'parsed' | 'extracting' | 'extracted' | 'resolving' | 'reconciling' | 'done' | 'failed',
  progress: { current: 3, total: 10 },   // pages processed — updated per page inside the parse/extract loops
  error?: string,
}));
```

The API WebSocket handler subscribes to that channel and forwards messages to the client.
This means the API process needs a dedicated Redis subscriber client (not the same connection
used for BullMQ). The frontend draws its progress bar from these per-page messages and
invalidates TanStack Query's `['facts']`/`['documents']` keys only on `status = 'done'`.

### Spot-check and precision logging

Manually inspect ~30 randomly sampled extracted facts against their source PDFs. Record results
in a table (JSONL or CSV is fine, just keep it). Log:
- `correct`: quote verified, entity correct, predicate sensible
- `quoteWrong`: `sourceQuote` does not appear verbatim in source
- `entityWrong`: merged when should be separate, or vice versa
- `predicateWrong`: predicate doesn't match the actual fact
- `valueWrong`: value is hallucinated or mis-parsed

**The final number belongs in the README.** "Spot-checked 30 facts from 3 PDFs, 26 correct (87%);
3 failures from table-page extraction, 1 entity mis-merge." That's a concrete, trustable claim.

### Exit criteria

1. All endpoints return correctly typed responses (Eden Treaty client shows no TypeScript errors).
2. WebSocket `status` events arrive within 2 seconds of a worker stage transition.
3. Spot-check complete, precision number recorded.

---

## Phase 6 — Frontend [Core]

See `ui-and-flow.md` for full screen designs. Implementation notes here focus on the non-obvious
technical parts.

### Eden Treaty client

```typescript
// lib/api.ts
import { treaty } from '@elysiajs/eden';
import type { App } from '../../api/src/index';  // shared type import

export const api = treaty<App>('http://localhost:3000');
```

All API calls go through this client. Type errors at call sites mean schema drift — fix them at
the source, don't cast.

### TanStack Query integration

```typescript
// lib/query.ts
export const queryKeys = {
  facts: (filters: FactFilters) => ['facts', filters] as const,
  fact: (id: string) => ['facts', id] as const,
  factRelationships: (id: string) => ['facts', id, 'relationships'] as const,
  entities: () => ['entities'] as const,
  entity: (id: string) => ['entities', id] as const,
  documents: () => ['documents'] as const,
};
```

Use `useQuery` for reads, `useMutation` for the PDF upload. Invalidate `['documents']` and
`['facts']` on successful upload.

### PDF viewer and evidence highlighting

`PDFViewer.tsx` is the most technically complex component. Two-layer approach:

1. **Canvas layer**: `pdfjs-dist` renders the page to a `<canvas>`. Scale = `devicePixelRatio`.
2. **SVG overlay layer**: positioned absolutely over the canvas, same dimensions. For each
   highlighted span, draw a `<rect>` using the `TextRun` position data from `position_data`
   (stored in Phase 1). Fill with `rgba(255, 230, 0, 0.35)`.

The position data is already in PDF-space coordinates. To map to canvas pixels:
```typescript
const scaleX = canvasWidth / page.view[2];   // canvas width / PDF page width
const scaleY = canvasHeight / page.view[3];  // canvas height / PDF page height
```

Finding which `TextRun` objects correspond to the `sourceQuote`: do a greedy substring match of
the quote against the concatenated text run strings (in their rendered order). Mark all matched
runs as highlighted. This is the same approach PDF.js uses for its own text search highlight.

### Upload flow

Upload button uses a hidden `<input type="file" accept=".pdf">`. On file selection:
1. POST as `multipart/form-data` via `api.documents.post({ file })`.
2. Immediately navigate to the Documents screen.
3. Open a WebSocket to `ws://localhost:3000/documents/:id/status`.
4. Render a live progress bar from WebSocket `{ progress.current, progress.total }`.
5. On `status = 'done'`, invalidate TanStack Query's `['facts']` and `['documents']` keys.

### Demo Highlights panel

The four pinned deep links in the Overview screen are **not computed live**. They are a small
JSON file committed to the repo after Phase 4 curation:

```json
// src/data/demoHighlights.json
{
  "corroboration": { "relationshipId": "uuid-...", "label": "Revenue confirmed across 2 docs" },
  "contradiction": { "relationshipId": "uuid-...", "label": "Director status conflict" },
  "reconciled":    { "relationshipId": "uuid-...", "label": "Revenue differs by fiscal year" },
  "failure":       { "factId": "uuid-...",         "label": "Merged-cell table mis-read" }
}
```

Each "view" button is a React Router `<Link to="/relationships/:id">` or `<Link to="/facts/:id">`.
This guarantees the four cases are findable in one click regardless of filtering state.

### Exit criteria

1. A reviewer with no database access can upload a PDF and see it progress from pending → done.
2. Clicking a fact opens Fact Detail with the source quote highlighted in the PDF viewer.
3. Relationships appear in the right panel with plain-language explanations.
4. Demo Highlights panel has all four rows, each navigating to the correct detail screen.
5. Facts table is filterable by entity and predicate without page reloads.

---

## Phase 7 — Incremental Ingestion Verification [Should-have]

### What to verify

The architecture is already incremental by design: the reconcile job only runs matching for facts
from the new document against the existing store. Verify this is actually true:

1. Add a log line in `consumers/reconcile.ts`:
   ```typescript
   logger.info({ documentId, factsToMatch: newFacts.length, existingFactsScanned: candidates.length },
     'reconcile job: only matching new facts, not reprocessing existing ones');
   ```
2. Upload a 4th PDF after the initial three.
3. Confirm that log line appears once, and its `factsToMatch` count is only for the 4th document.
4. Confirm no extraction or parsing jobs fire for documents 1–3.

Take a screenshot of the logs. Include it in the README under "Incremental Ingestion."

### Exit criteria

Upload a 4th document. Logs confirm only that document's facts were processed. No reprocessing
of existing documents occurred.

---

## Phase 8 — Failure Case [Core]

**Do not invent this.** Start logging candidates from Phase 1 onward.

### Log every anomaly

Add a `pipeline_events` table or a simple append-only log file:

```typescript
interface PipelineEvent {
  documentId: string;
  stage: 'parse' | 'extract' | 'resolve' | 'reconcile';
  severity: 'info' | 'warning' | 'error';
  message: string;
  data: Record<string, unknown>;
  timestamp: Date;
}
```

Emit a warning event for:
- `sourceQuoteValid = false` — quote hallucinated or mis-copied
- Per-page parse failure (`stage = 'parse'`, with `{ pageNumber, error }`) — page skipped, document continues
- Entity resolution confirmed "NO" by LLM after embedding distance suggested a match
- `generateObject` falling back to manual parse
- A relationship assigned `relationType = 'uncertain'`

### Candidate failure cases (from most to least likely)

1. **Table merged-cell mis-read**: a financial table with column spans. The model reads the wrong
   value for a row because it can't tell which column a value belongs to. Evidence: `confidence <
   0.7`, `sourceQuoteValid = false`.
2. **Entity false-merge**: two similarly named but distinct entities collapsed into one (e.g.,
   two "CEO" mentions in different companies). Evidence: facts with contradictory predicates
   under the same `entityId`.
3. **Qualifier-blind reconciliation**: a fact qualified by a footnote that the model didn't read,
   because the footnote was on a different page from the main figure. The LLM judge sees two
   different values and labels them `contradicts`, but the footnote explains the difference.
   Evidence: high-confidence `contradicts` relationship on facts that should be `reconciled`.
4. **Predicate drift**: the same concept coined as `revenue`, `total_revenue`, and `net_revenue`
   across pages in the same document, resulting in three separate `fact_types` rows instead of
   one. The canonicalization threshold was set too high.

Pick the most illustrative real failure. Document:
- What happened, with the actual extracted fact and its source text shown.
- Why the pipeline produced that output given its design.
- What a concrete fix looks like (stricter entity confirmation, lower canonicalization threshold,
  a footnote-linking pass, whatever actually applies to the real case).

### Exit criteria

A specific, real, documented failure — not a generic disclaimer about what "might" go wrong.

---

## Phase 9 — Stress Test [Should-have]

### Large PDF test

Find or create a PDF with 100+ pages (annual reports, SEC filings, and academic papers are good
sources). Run it through the pipeline. Record:

- Total wall-clock time
- Time per page in the parsing stage
- Time per chunk in the extraction stage (note: this is mostly LLM API latency)
- Memory high-water mark of the worker process (`process.memoryUsage().heapUsed`)

Expected bottleneck: LLM API calls. Parsing itself stays sequential (one page at a time per
the lazy stream); extraction gets concurrency. If extraction is too slow, add concurrency:

```typescript
// Process chunks in batches of 5 concurrently, not one at a time
const EXTRACTION_CONCURRENCY = 5;
await pMap(chunks, extractChunk, { concurrency: EXTRACTION_CONCURRENCY });
```

Use `p-map` or a simple semaphore. Do not `Promise.all()` all chunks at once — this will hit
rate limits.

### Many-PDF test

After the stress test: upload 10 PDFs (mix of the starter set plus any freely available PDFs
in the same domain). Verify:
- Fact matching still returns correct candidates (not false positives from unrelated entities).
- Query response time for `GET /facts` with 500+ facts stays under 200ms.

If query latency degrades: add the HNSW index (deferred from Phase 4):
```sql
CREATE INDEX CONCURRENTLY ON facts USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);
```

### Exit criteria

1. 100+ page PDF processes end-to-end without OOM or timeout.
2. Actual timing numbers recorded (not "it seemed fast").
3. Fact matching correctness verified with 10+ PDFs in the store.

---

## Phase 10 — Dynamic Schema Demonstration [Stretch]

Only attempt after Phases 0–9 are solid.

### What to demonstrate

Find or create a document that introduces a genuinely new category of fact — something that
doesn't appear in the starter PDFs. Good candidates: a PDF covering technical specifications
(introduces `component_voltage`, `compression_ratio` — facts that don't embed close to
`annual_revenue` or `director_status`).

Then demonstrate the canonicalization step by processing a follow-up document that refers to the
same fact category with slightly different wording. Confirm the step correctly maps to the
existing `fact_types` row rather than minting a duplicate.

### What to capture

A before/after of the `fact_types` table (screenshot or `SELECT` output) showing:
- New rows added for the genuinely new fact category.
- No new row created for a rewording of an existing category (e.g., "total annual income" not
  creating a new type alongside "annual_revenue" because they embed close enough).

### Exit criteria

The before/after is clean and clearly shows both the addition and the canonicalization. If the
demo isn't clean on the first attempt and time is short, cut it — a shaky demo reads worse than
omitting it.

---

## Phase 11 — README and Demo Video [Core]

### README structure

```markdown
# Grounded — Fact Knowledge Layer

## Setup and Run

## Video Demo

## Approach
- Architecture summary (reference architecture.md for depth)
- Key decisions with explicit trade-offs: pgvector vs. dedicated vector DB, Bun/Elysia vs. Node/Express,
  two-stage reconciliation, pdfjs-dist as the shared coordinate system
- AI tools used: Groq for speed, Gemini for reasoning and vision, Vercel AI SDK for structured output
- The four-tier pipeline pattern (rule pre-filter → embedding search → fast LLM → strong LLM)
- Superjoin relevance: this is the "one source of truth" problem in miniature — multiple docs,
  overlapping facts, same reconciliation challenge

## Limitations and Next Steps
- Honest assessment of extraction quality (use the Phase 5 precision number here)
- Named limitations: table extraction accuracy, entity resolution false-merge rate,
  LLM judge cost at scale
- Next steps: Cloudflare Workers + Vectorize for real-scale deployment, structured table parser
  (Camelot or similar) as an alternative to vision for tables, footnote-linking pass

## Additional Notes
```

### Video script (target: ≤ 3 minutes, ideally 2:30)

| Timestamp | What to show |
|---|---|
| 0:00–0:20 | Upload a PDF, show it processing live via WebSocket progress |
| 0:20–0:40 | Facts table populates — show filtering by entity, open a fact |
| 0:40–1:10 | Case 1 (corroboration) — Fact Detail showing two sources, explanation visible |
| 1:10–1:40 | Case 2 (genuine contradiction) — show both quotes on screen simultaneously |
| 1:40–2:10 | Case 3 (context-explained) — show the explanation naming the qualifying difference |
| 2:10–2:40 | Case 4 (failure) — show the mis-extracted fact and explain why it happened |
| 2:40–3:00 | Optional: show incremental upload of a 4th PDF, confirm existing docs untouched |

Record at 1920×1080. No dead air — if something takes time (processing), cut the video and jump
to after it completes. Show the UI, not the terminal.

### Exit criteria

1. Clean clone runs from README alone, no debug required.
2. Video is under 3 minutes, all four cases are shown with evidence and explanation on screen.
3. README precision number from Phase 5 appears.
4. README failure case from Phase 8 appears (real, specific, not generic).

---

## Suggested Timeline Mappings

**2–3 days**: Phases 0–6, 8, 11. Skip Phase 7's dedicated verification (add a log comment only),
skip Phases 9 and 10 entirely. Priority within Phase 6: PDF viewer with highlighting > Demo
Highlights panel > everything else.

**5–7 days**: All Core and Should-have phases (0–9, 11). Attempt Phase 10 only if everything
else is demoed and stable with at least a day left.

**10+ days**: Everything, plus real polish time on the frontend and on curating the cleanest
possible examples for each of the four required cases before recording the video.

---

## Common Failure Modes to Pre-empt

| Risk | Where it bites | Pre-emption |
|---|---|---|
| Gemini structured output not working on a specific model version | Phase 2 | Test structured output before building the extraction path. Have the raw-parse fallback ready from day one. |
| `pdfjs-dist` in Bun missing canvas bindings | Phase 1 table render | Install `canvas` npm package and test rendering a single table-heavy page (render → persist → `page.cleanup()` + zero canvas) before writing the rest of Phase 1. |
| Embedding model changed mid-project | Phases 2–4 | Lock to one model in `EMBEDDING_MODEL` env var. Never mix models in `facts.embedding`. |
| Entity false-merge corrupts reconciliation | Phase 3 | Don't trust embedding distance alone. The LLM confirmation call is non-optional. |
| WebSocket Redis subscriber shares connection with BullMQ | Phase 5 | Create a dedicated subscriber client. BullMQ's `IORedis` connection and a pub/sub subscriber must be separate instances. |
| Demo Highlights broken after DB reset | Phase 6 | Store IDs in `demoHighlights.json` only after confirmed final state. Re-run curation if DB is reset. |
| Video goes over 3 minutes | Phase 11 | Script it before recording. Do a dry run at 2× speed. |