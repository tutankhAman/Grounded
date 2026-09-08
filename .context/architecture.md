# Fact Knowledge Layer — Implementation Plan

Superjoin VIT 2026 Engineering Intern, Round 2

## 0. Framing

Superjoin's product pulls data from many sources into one sheet and gives teams "one source of truth."
This assignment is that same problem in miniature: multiple documents, overlapping facts, some agreeing,
some contradicting, some only appearing to contradict. Every design decision below should serve one goal:
make the reconciliation reasoning visible and trustworthy, not just produce a list of extracted numbers.

Non-goals: a polished production UI, exhaustive fact-type coverage, or handling every possible PDF layout.
The brief explicitly rewards a small, understandable system over a large, unclear one.

## 1. Architecture Overview

```
                     ┌─────────────────┐
    PDF upload  ───► │  Ingestion API   │
                     └────────┬─────────┘
                              ▼
                      ┌─────────────────┐
                      │  Parser/Chunker  │  (unpdf, page-by-page lazy stream; text + position; low-text/chart pages → image, tables text-first)
                      └────────┬─────────┘
                              ▼
                     ┌─────────────────┐
                     │ Fact Extractor   │  (Flash-Lite, structured output, output-budget batches with page markers)
                     └────────┬─────────┘
                              ▼
                     ┌─────────────────┐
                     │ Entity Resolver  │  (canonicalize people/orgs/places)
                     └────────┬─────────┘
                              ▼
                     ┌─────────────────┐
                     │  Fact Store      │  Postgres + pgvector
                     │  (facts, spans,  │
                     │  entities, docs) │
                     └────────┬─────────┘
                              ▼
                     ┌─────────────────┐
                     │ Matcher/Cluster  │  (embedding similarity, incremental)
                     └────────┬─────────┘
                              ▼
                     ┌─────────────────┐
                     │ Reconciliation   │  rule pre-filter → LLM judge → labeled
                     │ Engine           │  relationship + explanation
                     └────────┬─────────┘
                              ▼
                     ┌─────────────────┐
                     │  Query API + UI  │  fact browser, evidence viewer, graph view
                     └─────────────────┘
```

> **Implementation status (Sep 2026):** Ingestion → parsing → fact extraction are **built as described
> below** (unpdf streaming parse, batched gateway extraction, 001 embeddings). Entity resolution,
> matching, and reconciliation are **next** — §§4.3–4.5 are the execution spec, unchanged in intent,
> with provider references updated to the gateway setup.

Job queue (BullMQ + Redis) sits between ingestion and the extractor/matcher so large PDFs and multi-PDF
batches don't block the API, and so a new upload only triggers work for that document, not a full rebuild.

Streaming policy: PDF upload streams to disk (`Bun.write(path, file.stream())`, constant memory).
Page extraction is a lazy page-by-page stream — `getPage(i)` → extract → persist `page_chunks` →
`page.cleanup()` → publish per-page progress over the WebSocket status channel, never accumulating
all pages in memory. Source bytes stay resident (PDF xref trailer lives at EOF, so `getDocument`
holds the file); laziness is processing-level, not I/O-level. **Storage stays per-page; only LLM call
granularity is batched**: pages are packed to an output-token budget (~40–45K expected output, roughly
10–18 pages) with `<page n>` markers, and every returned fact carries a validated `pageNumber` — the
model can never invent grounding. Token streaming is rejected because schema validation and quote
verification need the complete object; per-batch embed-on-validate gives pipeline overlap without
touching that invariant.

## 2. Tech Stack

Fully TypeScript, single runtime end to end. No Python: `pdfjs-dist` gives per-page text with real
x/y/width position data (the same data PDF.js itself uses to draw its highlight layer), so backend
extraction and frontend evidence highlighting share one coordinate system, no translation between two
different libraries' idea of a bounding box. This also removes the earlier plan's cross-runtime queue
problem, BullMQ is Node-native, so producer and consumer now share a runtime with no bridge needed.

| Layer | Choice | Why |
|---|---|---|
| Runtime | Bun | Elysia's native runtime, faster startup/IO than Node, no separate TS build step, still one command to run for a reviewer |
| Backend/API | TypeScript, Elysia | fast to iterate, matches existing stack |
| API-to-frontend types | Elysia Eden Treaty | end-to-end type safety with no codegen step, bundled with Elysia already |
| Extraction/pipeline workers | TypeScript, same process family as the API | single runtime, no cross-language queue bridge |
| Queue | BullMQ + Redis | decouples ingestion from processing, enables incremental jobs, genuinely simple since both ends are Node/Bun |
| Live status | Elysia WebSockets | processing status pushed to the UI instead of polled, cheap since the framework already supports it |
| Database | PostgreSQL + pgvector | relational facts/evidence plus vector search in one store, no extra infra |
| ORM | Drizzle | native `vector()` column type and built-in distance functions (`cosineDistance`, etc.) as of 0.31+, fact-matching queries stay typed TypeScript instead of raw SQL strings |
| LLM extraction tooling | Vercel AI SDK (`generateObject`) with Zod schemas, via an OpenAI-compatible gateway (`@ai-sdk/openai` + `LLM_BASE_URL`; direct-Google `@ai-sdk/google` kept as env-switchable fallback) | constrains output to a schema instead of hand-parsed JSON; keep a validate-and-retry fallback since structured-output passthrough varies by gateway/proxy |
| LLM | `gemini-3.5-flash-lite` for text extraction + vision, `gemini-embedding-001` for all vectors (single `GEMINI`/gateway key family; 3.1 Flash-Lite as config fallback) | one vendor, one rate bucket; Lite wins long-context grounding benchmarks that matter for verbatim quotes; `thinkingBudget: 0` on extraction (thinking bills as output for zero benefit) |
| PDF parsing | `unpdf` (serverless pdf.js build, Bun-safe; text + position per run) | native TS, exposes the same position data the frontend viewer needs, no separate coordinate system |
| Tables | Tables go down the **text path** (linearized text is sufficient; merged-cell ambiguity is handled by confidence penalties + quote flags, and is the honest-failure candidate). Vision is reserved for low-text/chart pages plus single-escalation of table pages that yield zero/only-sub-0.7 facts | vision spend drops ~5–10x vs routing every table page; multi-image calls (3–4 pages each) |
| Frontend | Vite + React + React Router | no SSR/SEO need here, Next.js would add routing and server complexity this project doesn't use |
| Frontend data layer | TanStack Query + TanStack Table | fetching/caching and the facts browser table, standard choices that cut custom state-management code |
| Frontend PDF viewer | `pdfjs-dist` viewer pane (browser-side) | needed for inline evidence highlighting, shares pdf.js coordinates with the backend extractor |

### Considered and rejected

- **Cloudflare Workers + Durable Objects + Queues + Vectorize.** Genuinely more modern and scalable, and
  familiar from prior work, but it works against the graded "runs from my instructions" requirement:
  Docker Compose for Postgres and Redis is one command, Cloudflare's stack needs an account and binding
  setup even in local dev, and Vectorize has no full offline emulator. Worth one line in Limitations and
  Next Steps as the real-scale evolution path, not worth building for this submission.
- **A dedicated vector database** (Qdrant, LanceDB, Vectorize) instead of pgvector. Not justified at a few
  dozen to a few hundred facts, it would split the source of truth into two stores and add sync logic for
  a performance benefit that only matters at a scale this project won't reach.

## 3. Data Model

```sql
documents(
  id, filename, uploaded_at, page_count, status
)

entities(
  id, canonical_name, entity_type,   -- org, person, place, product, etc, inferred not hardcoded
  embedding vector(dim),
  created_at
)

entity_aliases(
  id, entity_id, surface_form, document_id, confidence
)

facts(
  id, document_id, entity_id,
  predicate,           -- e.g. "annual_revenue", "director_status" — inferred, not enum-constrained
  value,                -- normalized value where possible
  raw_value,            -- as stated in the source
  unit, currency,
  time_scope,           -- fiscal year / date / period, nullable
  qualifiers jsonb,      -- anything else that changes meaning (scope, condition, geography)
  embedding vector(dim), -- for cross-doc matching
  confidence,
  source_page, source_char_start, source_char_end, source_quote,
  extracted_at
)

fact_types(                        -- the dynamic schema
  id, name, description, example_predicates jsonb,
  embedding vector(dim), created_at
)

relationships(
  id, fact_a_id, fact_b_id,
  relation_type,       -- corroborates | contradicts | reconciled | uncertain
  explanation,          -- natural-language reasoning trace
  confidence,
  method,               -- 'rule' | 'llm_judge' | 'both'
  created_at
)
```

Fact types are rows, not an enum: when the extractor encounters a predicate that doesn't embed close to
any existing `fact_types` row, it proposes a new one. A canonicalization step checks embedding similarity
against existing types before minting a new one, so "revenue," "total revenue," and "net revenue" don't
silently fork into three types unless the document actually distinguishes them.

**Embedding Standard**: Embeddings use Google's `gemini-embedding-001` (text-only) configured with
Matryoshka Representation Learning (MRL) output dimensionality `dim = 1536` (`outputDimensionality: 1536`,
a Google-recommended point scoring ~68.2 MTEB, near the top of the curve). This stays within pgvector's
2,000-dimension limit for standard float4 HNSW vector index operations (`embedding vector_cosine_ops`),
avoiding halfvec overhead. 001 is chosen over `gemini-embedding-2` deliberately: 2 aggregates list
inputs into a *single* vector (per Google's embeddings doc), which breaks per-fact batch embedding —
001 returns true per-string vectors, and unlike 2 it supports explicit `task_type`. Convention:
`RETRIEVAL_DOCUMENT` for stored vectors (facts, fact types, entities), `RETRIEVAL_QUERY` /
`SEMANTIC_SIMILARITY` at match time. Because 001 does not auto-normalize truncated dims, every vector
is L2-normalized client-side before insert (one-line helper, unit-tested). Never mix models in the same
vector column, or cosine similarity becomes meaningless across rows.

## 4. Pipeline Stages

### 4.1 Ingestion and parsing
- Upload handling: Bun/Elysia configures `maxRequestBodySize` derived from the bounded `MAX_UPLOAD_MB`
  limit (100MB default), rejecting oversized request bodies before parsing and preventing memory exhaustion
  while validating and writing the file. Page extraction in the worker is a lazy sequential stream: `for (i = 1..numPages)` → `getPage(i)` → `getTextContent()` →
  insert the `page_chunks` row immediately → `page.cleanup()` → `redis.publish(doc:status, {current, total})`.
  Worker extraction memory stays strictly O(1 page). Never `Promise.all()` pages. Upsert on
  `(documentId, pageNumber, chunkIndex)` so a crashed job resumes without duplicates; wrap each
  page in try/catch so one bad page emits a `pipeline_events` warning and continues instead of
  failing the document. Chunk by page or logical section, not fixed token windows, so evidence
  spans stay meaningful and map cleanly to what the frontend viewer highlights.
- Detect table-heavy pages (density of numeric tokens and short lines is a cheap heuristic) but route
  them down the **text path** — linearized table text is sufficient for extraction, and merged-cell
  ambiguity is handled downstream by confidence penalties + quote flags (it is also the most natural
  honest-failure candidate; spending vision to hide it would cost money and the best failure exhibit).
  Render **low-text pages only** (`rawText.length < ~1000` chars or text-item count < N — e.g.
  earnings-deck chart slides where the figures live in vector graphics, not extractable text): the
  numeric-density heuristic never fires there, so without this fallback those pages would go down the
  text path with almost nothing. Plus a single-escalation rule: a table-heavy page yielding zero facts
  or only sub-0.7-confidence facts gets one vision attempt.
  Render vision pages only (3–4 pages per multi-image call), at tuned scale (`RENDER_SCALE`, default
  1.5 — legibility verified once against the earnings deck, then pinned), persisting PNGs under
  `UPLOAD_DIR/images/{docId}/`, then immediately release canvas memory (`page.cleanup()`, zero
  the canvas, drop refs). Quote validation is skipped for vision-only facts with no source text —
  they persist with `sourceQuoteValid = false` + `{ visionOnly: true }` (flagged, not silently dropped).
  LLMs mis-read merged cells and multi-row headers from raw text more than they misread a table
  they can actually see. Store trimmed run fields (`str`, x, y, width, height) in `position_data`,
  not raw pdfjs objects.
- `sourcePage` is the PDF page index (1-based position in the file) — it drives the evidence viewer.
  The starter excerpts retain non-contiguous originals, so printed page numbers jump; capture any
  printed label the model reads in `qualifiers.printedPage` and never conflate it with `sourcePage`.

### 4.2 Fact extraction
- Define a Zod schema (entity, predicate, value, unit, time_scope, qualifiers, verbatim quote,
  self-reported confidence, plus per-fact `pageNumber` for batched calls) and call it through the Vercel
  AI SDK's `generateObject` against Flash-Lite via the gateway, so text and vision paths return the same
  shape. No token streaming: structured output plus the verbatim-quote check require the complete object.
  Calls are packed to an **output-token budget** (~40–45K expected output, ~10–18 pages per call;
  small docs collapse to a single call) with `<page n>` markers — never fixed 50-page batches, which
  would silently truncate against the 64K output cap on dense docs. Failed batches split-half retry,
  then mark pages failed and continue.
- `thinkingBudget: 0` on all extraction/vision calls (thinking bills as output for zero extraction
  benefit). Confirm the gateway forwards native structured output (not downgraded JSON mode) before
  relying on it — verified in the passthrough spike — and keep a parse-and-validate fallback for
  when it fails rather than assuming the schema constraint always holds.
- Do not hardcode a fact schema in the prompt beyond a few example shapes. Ask the model to state what
  kind of fact it found; that becomes the `fact_types` proposal. Batch-aware prompt: emit each distinct
  fact once across the batch (cross-page dedup at generation), keep the richest instance.
- Validate each fact's quote against **its own page's** raw text (string match) before accepting the fact. This
  is a cheap, reliable check against hallucinated evidence and doubles as the failure-detection hook.
- Rate discipline: a process-global token bucket just under the gateway RPM, 429 → exponential backoff +
  jitter pausing the bucket globally, single keep-alive HTTP client. `EXTRACT_CONCURRENCY` (default 6)
  is downstream of the dashboard number, never chosen for elegance.

### 4.3 Entity resolution
- Within a document: cluster surface forms by string similarity + embedding.
- Across documents: match new entities against existing `entities` by embedding distance, confirm close
  matches with a lightweight LLM check (given two names and their local context, same entity or not).
  Both the check and the embeddings run on the same gateway setup as extraction (Flash-Lite,
  `thinkingBudget: 0`; entity vectors embedded with `task_type: RETRIEVAL_DOCUMENT`, compared with
  cosine similarity) — no new vendor, no new key, inside the same rate bucket.
- This is the part most submissions skip. Handle it deliberately, it directly maps to the address/director
  example in the brief.

### 4.4 Fact matching
- For each new fact, pgvector nearest-neighbor search over existing facts sharing an entity (or a resolved
  alias) and a similar predicate embedding. This is what makes ingestion incremental: only the new
  document's facts need to run this search, existing facts are untouched.

### 4.5 Reconciliation engine
Two-stage, cheap-first:
1. Rule-based pre-filter: unit conversion, date/period comparison, exact value match. Resolves the easy
   cases (identical value, or a scope difference that's mechanically detectable) without an LLM call.
2. LLM judge for anything ambiguous: given both facts plus their qualifiers and quotes, classify as
   corroborates / contradicts / reconciled-by-context / uncertain, and return the explanation as text.
   Store the explanation. This is what turns a true/false label into something a reviewer can trust.

### 4.6 Confidence and uncertainty
- Every fact and every relationship carries a confidence score and, where relevant, a stated reason for
  low confidence (ambiguous scope, OCR uncertainty, conflicting qualifiers). Surface this in the UI rather
  than hiding it. The brief explicitly asks for sensible handling of ambiguity, not resolution of all of it.

## 5. API Surface

```
POST   /documents                 upload a PDF (streamed to disk), kicks off async processing
WS     /documents/:id/status      live per-page processing status ({status, progress.current/total}), pushed not polled
GET    /facts?entity=&predicate=  browse/filter facts
GET    /facts/:id                 fact detail with evidence span
GET    /facts/:id/relationships   corroborations/contradictions for this fact
GET    /entities/:id              canonical entity + all aliases + all facts
```

Keep it this thin. The brief says a graph viz or storage layer alone isn't the point, so the API's job is
just to expose the reasoning, not to be impressive on its own.

## 6. UI

- Upload panel + processing status.
- Fact table, filterable by entity/predicate/document.
- Fact detail view: the fact, its quote highlighted inline in a rendered PDF page (not just cited by page
  number), and a relationships panel showing every corroborating/contradicting/reconciled fact with the
  engine's explanation in plain language.
- This is the highest-leverage screen for the demo video: one view that shows extraction, grounding, and
  reasoning simultaneously.

## 7. The Four Required Cases

Facts for these should come from the actual starter PDFs once available, not be pre-decided. Process to
find each:

1. **Corroboration**: after matching, filter relationships where `relation_type = corroborates` and the
   `raw_value` differs textually between the two facts (proves it's not just an exact string match).
2. **Genuine contradiction**: filter `contradicts` results with high confidence and no qualifier difference
   that would explain it.
3. **Context-explained apparent contradiction**: filter `reconciled`, pick one where the raw values look
   contradictory at a glance but the qualifiers (different fiscal year, different currency, different
   scope) clearly explain it. This is the case worth spending the most curation time on, it's the one that
   actually demonstrates reasoning rather than pattern matching.
4. **Failure case**: run the full pipeline honestly and look for a real miss, don't manufacture one. Likely
   candidates given this architecture: a table with merged headers misread by the extractor, an entity
   resolution false-merge (two similarly named but distinct entities collapsed into one), or a qualifier
   the LLM judge missed (e.g., a footnote changing a figure's scope). Document what happened and what a
   fix would look like (stricter entity confirmation threshold, a table-aware parser, a footnote-linking
   pass).

## 8. Brownie Points, in Priority Order

1. **Incremental ingestion** (near-free if the architecture above is followed from the start): new PDF
   only runs extraction + matching for itself, existing facts are untouched. Demonstrate by uploading a
   4th PDF after the initial 3 and timing it, or showing logs that confirm no reprocessing of old docs.
2. **Dynamic schema**: show the `fact_types` table growing as documents introduce new kinds of facts, and
   show the canonicalization step preventing near-duplicate types.
3. **Large PDFs**: chunked, queued processing with progress reporting. Test against a genuinely large PDF
   (100+ pages) and report actual timing, not just a claim that it "should work."
4. **Many PDFs**: mostly falls out of pgvector's indexing (ivfflat/hnsw) plus the incremental design. Worth
   a short note in the README on how it scales, doesn't need a separate feature.

## 9. Build Phases

Ordered by dependency, not fixed to specific days since the timeline isn't fixed yet. Each phase should be
demoable on its own before moving to the next; that protects against running out of time with nothing
working end to end.

**Phase 1: Core pipeline, single document** ✅ BUILT (Sep 2026)
Parsing (unpdf lazy stream), batched gateway extraction with quote validation, 001 embeddings,
`fact_types` canonicalization, storage. No matching yet. Success = upload a PDF, see grounded
facts with real quotes. Recorded wall-clock + spend per run replace estimates from here on.

**Phase 2: Multi-document matching + reconciliation** ⬅ NEXT
Entity resolution, fact matching, the two-stage reconciliation engine. Success = the four required cases
are producible from the three starter PDFs.

**Phase 3: API + UI**
Thin API, fact browser, evidence viewer with inline PDF highlighting. Success = a reviewer can upload a
PDF and inspect results without reading your database.

**Phase 4: Incremental ingestion + dynamic schema**
Retrofit is expensive, but most of this should already exist if Phase 1-2 followed the data model above.
This phase is mostly verification and demonstration, not new architecture.

**Phase 5: Stress test + honest failure hunting**
Large PDF, several more PDFs, deliberately look for and document a real failure.

**Phase 6: README + demo video**
Write the four required README sections. Script the 3-minute video tightly: one PDF upload, then each of
the four cases shown with evidence and explanation on screen, no dead air.

## 10. README Structure (matches submission requirements)

- Setup and Run Instructions
- Video Demo (link)
- Approach: architecture, key decisions (why pgvector, why the two-stage reconciliation, why entity
  resolution mattered), the Superjoin-relevance framing from Section 0, AI tools used
- Limitations and Next Steps: name what's genuinely unfinished, don't oversell
- Additional Notes

## 11. Risks and Open Questions

- Starter PDFs in hand (`starter-datasets/`, Delhivery + India-macroeconomy excerpts): thresholds were
  tuned against them but stay env-overridable and content-agnostic — never add per-document branches.
  Demo cases get curated from real output in the reconciliation phase, not pre-decided.
- Gateway budget + rate discipline: ~$5 credit covers the assignment at ~$0.50–0.70 per dense 100-pager;
  live-test dollar caps stay mandatory, fixture tests stay 1–2 pages, full-doc live runs are explicit
  smoke tests only. Client token bucket just under dashboard RPM; 429 → backoff + split-half retry.
- LLM judge cost/latency for reconciliation at scale: fine for 3-4 PDFs on the gateway, would need
  batching or caching for "many PDFs" at real scale. Worth one sentence in Limitations, not worth solving now.
- Table extraction is the likeliest source of the failure case — now by design, since tables go down
  the text path. Budget time to look for it rather than treating it as a risk to avoid.
- Free-tier/direct-Google fallback: no context caching, ~10–15 RPM. If the gateway is ever bypassed,
  drop `EXTRACT_CONCURRENCY` to 3–4. The code path is identical (env-only switch).