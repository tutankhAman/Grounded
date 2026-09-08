# Grounded — Demo Script

> **Target runtime: ~2:45 to 3:00 minutes**
> Record at 1920×1080. No dead air. Cursor always moving with intention.

---

## 0. Before You Hit Record (two passes: curate, then record)

**Pass A — process everything (not on camera).** Upload all three starter PDFs and let the
pipeline finish completely. The two 100-page excerpts take several minutes each — this is
compute time, not demo time. Verify all three documents reach `done`.

**Pass B — curate the four cases (not on camera).** Nothing below may be invented on the
spot. Run these queries, pick the best row of each kind, and pin the IDs into
`apps/web/src/data/demoHighlights.json` (all four IDs are currently empty strings):

```sql
-- Case 1 (corroboration): same fact, textually different values
SELECT r.id FROM relationships r
JOIN facts a ON a.id = r.fact_a_id JOIN facts b ON b.id = r.fact_b_id
WHERE r.relation_type = 'corroborates' AND a.raw_value != b.raw_value LIMIT 5;

-- Case 2 (contradiction): highest-confidence contradicts first
SELECT id, confidence, left(explanation, 200) FROM relationships
WHERE relation_type = 'contradicts' ORDER BY confidence DESC LIMIT 5;
-- If zero rows: fall back to the top 'uncertain' row and frame it on camera
-- EXACTLY as the brief allows: a *likely* contradiction under review.
-- Do NOT present it as a confirmed contradiction.

-- Case 3 (reconciled): explanation must name the qualifying difference
SELECT id, left(explanation, 200) FROM relationships
WHERE relation_type = 'reconciled' ORDER BY confidence DESC LIMIT 10;
-- Pick one where raw values look contradictory at a glance (different numbers,
-- same metric label) and the explanation cites fiscal year / currency / scope.

-- Case 4 (failure): real flagged facts only
SELECT id, predicate, value, confidence, source_quote_valid FROM facts
WHERE source_quote_valid = false OR confidence < 0.7
ORDER BY confidence ASC LIMIT 10;
-- Pick one you can explain: merged-cell misread, ambiguous scope, vision-only
-- chart fact. Document the why + the concrete fix, per Phase 8.
```

Also pick one entity with 2+ aliases for the entity-resolution beat:
```sql
SELECT e.id, e.canonical_name, count(a.id) FROM entities e
JOIN entity_aliases a ON a.entity_id = e.id
GROUP BY 1, 2 HAVING count(a.id) >= 2 LIMIT 5;
```

**Pass C — record.** Fresh DB is NOT required and NOT recommended: reprocessing three
documents on camera would eat the whole runtime. Instead: truncate, re-upload ONLY the
27-page earnings deck live (it finishes in ~2 minutes — one jump cut covers it), with the
two 100-pagers already processed... no. Simpler and honest: record the cold-open + live
upload of the 27-pager FIRST on a clean DB, jump-cut through its pipeline, then cut to
the pre-processed three-document state for the cases. The narration marks the cut
explicitly ("jumping ahead two minutes"). Never imply the 100-pagers processed in seconds.

Checklist before recording:
- `bun run dev` running. API :3000, UI :5173, worker ready, Redis + Postgres up.
- Starter PDFs at hand. Terminal visible in background (optional, makes it feel alive).
- `demoHighlights.json` pinned with the four real IDs from Pass B.
- Know your four rows cold — clicking around hunting kills the sub-minute requirement.

---

## 1. Cold Open — Overview, Zero State (0:00–0:15)

*Pan the overview page slowly. Don't talk yet for 2 seconds. Let it breathe.*

> "Okay so this is Grounded — it's a fact knowledge layer I built from scratch. The idea is simple: you throw PDFs at it, it extracts every meaningful claim, grounds each one to its exact sentence in the source, and then automatically figures out which facts across different documents agree, conflict, or only *look* like they conflict."

*Point to the four metric cards: Documents 0, Facts 0, Relationships 0, Entities 0.*

> "Right now it's completely empty. No hardcoded data, no fixtures. Let's change that."

---

## 2. Upload — Delhivery Q4 Earnings Presentation (0:15–0:55)

*Click "+ Upload PDF" in the sidebar. Select `03-delhivery-q4-fy24-earnings-presentation.pdf` (27 pages).*

> "Uploading the Q4 FY24 earnings deck — 27 pages of financial slides. Let me walk through exactly what happens from the moment it hits the API."

*Navigate to Documents page. Status shows `Parsing`. Point at the progress bar.*

> "Stage one: Parse. The brief said 'extract facts from PDFs' — most implementations just dump the whole document into a prompt. We don't. The parser streams page-by-page using unpdf, a serverless pdf.js build. One page in memory at a time — O(1) memory regardless of doc size. It pulls not just the text but the actual bounding boxes: x, y, width, height per text run. Those bounding boxes are stored in the DB and are what make the highlights work later. Same coordinate system as the browser-side viewer, so no translation layer needed."

*Status flips to `Extracting`.*

> "Stage two: Extract. The problem statement said 'extract meaningful facts linked to source evidence'. Here's how we actually do it — we batch pages to a fixed *output-token budget*, roughly 10 to 18 pages per LLM call with page markers embedded. Not 50 pages, not the whole doc. Why? Because Flash-Lite has a 64K output cap — naive fixed-size batches silently truncate on dense pages. We also set the model's thinking budget to zero — thinking bills as output tokens at zero extraction benefit. And the model is constrained to a Zod schema via Vercel AI SDK's generateObject — structured output, not hand-parsed JSON."

> "Every fact the model returns gets its source quote validated against the actual page text before it's stored. If it hallucinated evidence, the quote won't be in the text. That fact gets a `quoteMismatch` flag and its confidence halved — it goes in, but it's flagged, not silently dropped. That's the grounding guarantee."

*Status flips to `Resolving`.*

> "Stage three: Entity resolution. The brief explicitly mentioned addresses and directors appearing differently across documents as a hard problem. Within the document: surface forms cluster by string similarity — Jaro-Winkler plus Levenshtein. Across documents: pgvector cosine search on 1536-dimension embeddings against all existing entities, with an LLM confirmation step for borderline matches. 'Delhivery', 'Delhivery Limited', 'Delhivery Ltd' across three documents — one canonical entity row, all three as aliases, each linked back to the document that introduced that surface form."

*Status flips to `Reconciling`. Wait for `done`.*

> "Stage four: Reconciliation. Two-tier, cheap-first — rule engine goes first, LLM judge only sees what the rules can't resolve. The rules handle unit conversion, multiplier math, exact value match, and timeScope comparison. Most corroborations get classified here at zero LLM cost. Anything ambiguous escalates to the judge, which gets both facts, both verbatim quotes, and the qualifiers, and returns a classification plus a plain-language explanation. That explanation is stored in the relationships table — it's the actual deliverable, not just the label."

**[JUMP CUT — say it on camera:]**
> "That whole run — all four stages — takes about two minutes on the 27-pager. Measured from logs, not estimated. Jumping ahead…"

*Cut to the finished row: status `done`. Show the real fact count from your run.*

> "Done. [STATE REAL FACT COUNT] facts from 27 slides, all grounded, all source-validated. The problem statement asked for a system that extracts meaningful facts and links them to evidence. What we built also validates each extraction against the source, flags anything that can't be confirmed, handles large PDFs page-by-page without memory blowup, and streams every stage update to the browser in real time — no polling anywhere."

---

## 3. The Other Two Documents — Already Processed (0:50–1:05)

*Cut to Documents page showing all three excerpts `done`: the Q4 deck plus the 100-page Annual Report FY24 excerpt and the 100-page 2022 Prospectus excerpt (processed in Pass A).*

> "The other two excerpts — 100 pages each, different periods, different formats, same company — went through the same pipeline earlier. Different time periods is exactly what makes the next part interesting."

> "And this is incremental — each upload only runs the pipeline for the new document. Nothing reruns on what's already processed. The reconciler only searches pairs involving the new document's facts."

---

## 4. Facts Table — Grounding in Action (1:05–1:25)

*Navigate to Facts page.*

> "So the Facts table — every row is a discrete claim. Entity, predicate, the raw value as written in the document, what page it came from."

*Click on any fact about revenue or EBITDA. Opens Fact Detail.*

> "This is the screen that actually matters. Left side is the PDF, rendered directly in the browser using pdfjs-dist — same pdf.js coordinate system the backend extractor uses, so no translation layer."

*Point at the yellow highlight box on the PDF page.*

> "That highlight? That's not a page citation. That's the exact sentence the model pulled, mapped from the stored bounding boxes onto the rendered canvas. If a quote ever fails validation, the fact is flagged right here in the UI instead of pretending to be grounded."

*Point at the right panel with relationships.*

> "And every cross-document relationship lands here, each with the engine's plain-language explanation — not just a label."

---

## 5. Case 1 — Corroboration (1:25–1:45)

*Open the pinned corroboration from Demo Highlights (curated in Pass B — real IDs, not placeholders).*

> "Case one — corroboration. [STATE THE ACTUAL PAIR FROM YOUR CURATION — e.g.:] the Q4 presentation and the Annual Report both report this metric for the same period in slightly different phrasing — same fact, two independent filings."

*Open the relationship. Show both fact cards, both highlighted sources.*

> "Both sides link back to their source. The engine classified this as `corroborates` through the rule engine first — same entity, same predicate class, same time scope, values within tolerance. Zero LLM tokens spent on this one."

---

## 6. Case 2 — Contradiction, or Honestly Its Absence (1:45–2:00)

*Open the pinned contradiction row — or the fallback, per Pass B.*

> "Case two — [IF A REAL ONE WAS CURATED:] a genuine contradiction the system caught, not something set up. [STATE IT.] The rule engine escalated it because the values differ under identical scope with no qualifier to explain it, and the LLM judge came back `contradicts` with its reasoning stored alongside — that explanation is the deliverable, not the red badge."

> "[IF ONLY AN UNCERTAIN EXISTS — say exactly this, no embellishment:] Honestly? Across three filings from the same company, the judge evaluated every ambiguous pair and reconciled nearly all of them — same-company numbers mostly differ by period, not by truth. The closest thing to a live conflict is this `uncertain` pair, flagged for human review rather than force-classified. The brief asks for genuine *or likely* — this is the likely, shown with its uncertainty intact instead of dressed up as a contradiction."

*Never present an uncertain row as a confirmed contradiction. A reviewer checking the relationship type would catch it instantly and it would poison everything else.*

---

## 7. Case 3 — Context-Explained Conflict / Reconciled (2:00–2:15)

*Open the pinned reconciled row (curated — explanation must name the qualifier).*

> "Case three — the most interesting one. Two numbers that look like they disagree but don't."

*Open the relationship. [STATE THE ACTUAL PAIR FROM YOUR CURATION — the explanation must name the difference, e.g. fiscal periods, currency, scope.]*

> "At a glance it's a contradiction. But [the qualifier — e.g. different fiscal years], and the judge caught that. `reconciled`, with the reasoning stored right here. That's the case the whole architecture exists for — visible reasoning, not just a label."

---

## 8. Case 4 — Known Failure (2:15–2:30)

*Open the pinned failure fact (curated — a real flagged row).*

> "Case four — and I'm not hiding this one. [STATE THE ACTUAL FAILURE FROM YOUR CURATION — e.g.:] a table-heavy page with merged headers; the extractor linearized the text and attached a value to the wrong row. The fact came back low-confidence with a mismatch flag, stored in the DB and surfaced here."

*Show the confidence badge / flag on the fact row.*

> "That flag means: treat this with skepticism. The fix is concrete — [STATE THE REAL FIX FOR YOUR CASE, e.g. route low-confidence table pages through the existing vision path, or tighten the numeric-density threshold]. Flagged, documented, improvable — which is the entire point of showing it."

---

## 9. Brownie Points Speed Round (2:30–2:50)

*Stay on the Entities page.*

> "A few extra things worth pointing out:"

**Dynamic schema:**
> "The `fact_types` table grows as documents are processed. New predicate? The extractor proposes a type, checks embedding similarity against existing types first, and only mints a row if it's genuinely novel. Schema evolves with the data — no migrations per document type."

**Entity resolution:**
*Scroll to the curated multi-alias entity from Pass B.*

> "Entity resolution — [STATE THE ACTUAL ALIASES FROM YOUR CURATION]. String similarity, pgvector cosine search on embeddings, and an LLM confirmation step before merging. Without it you'd get a separate row per surface form and cross-document matching would silently miss."

**100-page PDFs:**
> "The two 100-page excerpts processed end to end. Parser streams one page at a time — bounded memory per stage, never the whole document at once. Extraction batches pages to a fixed output budget with per-page grounding preserved, so big files scale the same as small ones."

**Incremental ingestion:**
> "And every upload is truly incremental. New document, new pipeline run. Existing facts stay untouched — the reconciler only evaluates pairs involving the new facts. You saw the log line in the worker output: it says exactly which facts it's matching."

---

## 10. Close (2:50–3:00)

*Return to Overview. All four metric cards filled in.*

> "That's Grounded. TypeScript end to end on Bun. Elysia API, BullMQ workers, Drizzle plus pgvector for the fact store, Vite React for the UI. One command to start, one docker-compose for the infra."

*Pause one beat.*

> "Everything else is in the README."

*End recording.*

---

## Appendix: What Makes This Different (if asked in person / in README)

| What | Why it matters |
|---|---|
| **Verbatim quote validation** | Every text-path fact checks its `sourceQuote` against the source chunk before storing. Failures get confidence halved plus a `quoteMismatch` flag — flagged in the DB and the UI, never silently dropped. Vision-only facts carry `sourceQuoteValid: false` explicitly. |
| **Same coordinate system: backend + frontend** | `unpdf` in the worker extracts bounding boxes. `pdfjs-dist` in the browser renders the same PDF. Coordinates translate directly — highlights land on the right text, no approximation layer. |
| **2-tier reconciliation** | Deterministic rule engine first (timeScope comparison, unit normalization, multiplier math, exact value match). Most corroborations resolve at zero LLM cost. The LLM judge only sees genuinely ambiguous pairs — and its explanation is stored, not just its verdict. Every judge error is also stored as `uncertain` with the error text, never hidden. |
| **Vision fallback for low-text and chart pages** | Pages with almost no extractable text get rendered to PNG and sent to the vision model, several pages per call. Table-heavy pages that yield zero or only weak facts get one escalation attempt. `needsVision` means low-text only — tables go down the text path first. |
| **Dynamic fact types, not an enum** | New predicates trigger a new `fact_types` candidate. Embedding similarity check against existing types runs first — prevents near-duplicate type proliferation. |
| **Incremental, not rebuild-on-upload** | New document runs only its own pipeline stages. Existing facts are immutable once stored. Reconciliation evaluates only the new fact set against existing ones. Re-runs are idempotent (delete-first scoped to the document). |
| **Live WebSocket progress with ETA, no polling** | Worker publishes per-stage progress to Redis pub/sub with elapsed-time stamps. API subscribes (with verified subscriptions — a failed subscribe surfaces an error instead of silently stalling) and bridges to the browser. The UI shows a live bar plus a time estimate that keeps counting down between events. |
| **165 keyless unit tests green, plus DB-backed integration suites** | Measured, not estimated: 54 API + 111 worker unit tests passing. Integration suites for parse/extract/resolve/reconcile run against real Postgres (+ live LLM where marked). |
| **Honest numbers only** | Wall-clock (~2 min for the 27-page deck), fact counts, and the spot-check precision number are all measured from real runs and printed in logs — no estimates presented as facts. |

---

## Appendix B: Curation Checklist (complete before recording — no exceptions)

- [ ] All three starter PDFs at `done` (no `extracting`/`failed` rows lingering)
- [ ] `demoHighlights.json` has four real, verified IDs (open each link, confirm it lands correctly)
- [ ] Corroboration row: raw values textually differ (proves non-trivial matching)
- [ ] Contradiction row exists, OR fallback uncertain row chosen + honest narration rehearsed
- [ ] Reconciled row's explanation names the qualifier out loud-readable on camera
- [ ] Failure row is real (flagged fact) with a stated concrete fix
- [ ] Multi-alias entity verified in the UI (aliases listed, facts linked)
- [ ] Spot-check precision number recorded for the README
- [ ] Do a full dry run at 2× speed; cut anything that drags. No dead air.
