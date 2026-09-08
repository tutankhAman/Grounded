# Fact Knowledge Layer — UI and Flow

Companion to plan.md and development-plan.md. Covers Phase 6 (Frontend) in detail.

## 0. The Actual Design Goal

"Easily navigable" here has a specific, narrow meaning: a reviewer who has never seen your system before
should be able to find all four required cases in under a minute, without reading your code or guessing
where things are. Everything below is built around that, not around UI polish for its own sake. The single
highest-leverage screen in this whole document is the Demo Highlights panel in Section 3.1, build that
even if something else gets cut.

## 1. Why Sidebar-First Fits

This is genuinely the right structural call, not just a stylistic preference. The content here (facts,
entities, documents, relationships) is exactly the kind of interlinked, browsable data that a persistent
sidebar plus list-and-detail layout handles well (Notion, Linear, and most data-exploration tools use this
same shape for the same reason: the user is constantly jumping between a small number of top-level
categories and a deep, variable amount of content within each one). A wizard-style or tab-based flow would
actively work against you here, since a reviewer needs to jump between facts, their evidence, and their
relationships non-linearly.

One constraint worth holding to: keep the sidebar to five or six top-level items. A sidebar-first design
only stays "easily navigable" if it doesn't grow into its own nested tree. If a screen doesn't clearly
belong at the top level, it belongs inside an existing screen instead of adding a new nav item.

## 2. Sidebar Structure

```
┌──────────────────┐
│  Fact Knowledge   │
│  Layer            │
├──────────────────┤
│ ⬤ Overview        │  ← Demo Highlights + processing status
│ ⬤ Documents       │  ← upload + list + status
│ ⬤ Facts           │  ← browsable table, filters
│ ⬤ Relationships   │  ← the four required cases, organized by type
│ ⬤ Entities        │  ← canonical entities + aliases
├──────────────────┤
│ + Upload PDF      │  ← persistent action, not a nav item
└──────────────────┘
```

Five nav items plus one persistent action. "Upload PDF" is deliberately not a sidebar item, it's a
standing button pinned below the nav so it's reachable from anywhere without competing for top-level space.

## 3. Screens

### 3.1 Overview (landing screen)

This is the screen a reviewer sees first, so it does the most work.

```
┌────────────────────────────────────────────────────────────┐
│  Overview                                                    │
├────────────────────────────────────────────────────────────┤
│  Documents: 3   Facts: 47   Relationships: 12                │
│                                                                │
│  Demo Highlights                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ✓ Corroborated fact           → view                   │   │
│  │ ✗ Contradiction                → view                   │   │
│  │ ◐ Context-explained conflict   → view                   │   │
│  │ ⚠ Known extraction failure     → view                   │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────┘
```

The four rows in Demo Highlights are pinned deep links, set once you've curated the four required cases
during Phase 4 and Phase 8 of the development plan, not computed live. Each "view" click drops straight
into the Relationship Detail (3.4) or Fact Detail (3.3) screen for that exact case. This is what makes the
four required cases "exactly what's been asked" and one click away, instead of something a reviewer has to
hunt for across a facts table.

### 3.2 Documents

```
┌────────────────────────────────────────────────────────────┐
│  Documents                                    [+ Upload PDF] │
├────────────────────────────────────────────────────────────┤
│  annual_report_2024.pdf     ●processed    38 facts           │
│  board_minutes_q3.pdf       ●processed    22 facts           │
│  press_release.pdf          ◐processing                       │
└────────────────────────────────────────────────────────────┘
```

Status indicator (pending / processing / processed / failed) matters more than any other detail on this
screen, it's the honest signal that ingestion is actually async and working, which is worth showing plainly
rather than hiding behind a spinner. The processing state shows a per-page progress bar driven by the
WebSocket `doc:<id>:status` messages (`{ status, progress: { current, total } }` published per parsed
page); TanStack Query's `['facts']`/`['documents']` keys invalidate only when `status = 'done'`.

### 3.3 Facts

```
┌────────────────────────────────────────────────────────────┐
│  Facts          [entity ▾] [predicate ▾] [search......]      │
├────────────────────────────────────────────────────────────┤
│  Acme Corp  │ annual_revenue    │ $4.2M (FY24) │ 2 sources    │
│  Acme Corp  │ director_status   │ active        │ 1 source     │
│  Acme Inc.  │ hq_address        │ 12 Main St    │ 3 sources    │
└────────────────────────────────────────────────────────────┘
```

Clicking a row opens Fact Detail. The "N sources" column is doing real work here, it's the visible hint
that this fact has cross-document relationships worth checking, before the user even opens it.

### 3.4 Fact Detail / Relationship Detail

The most important screen in the app, this is where extraction, grounding, and reasoning are all visible
at once.

```
┌───────────────────────────────┬──────────────────────────────┐
│  PDF Viewer (pdfjs-dist)        │  Fact: annual_revenue          │
│                                  │  Acme Corp · $4.2M · FY24       │
│  ...page text rendered...       │  Source: annual_report.pdf, p.3 │
│  ┌────────────────────────┐    │                                  │
│  │ highlighted quote span  │    │  Relationships                  │
│  └────────────────────────┘    │  ┌────────────────────────────┐ │
│                                  │  │ ◐ board_minutes.pdf, p.1   │ │
│                                  │  │   "$3.8M" — different       │ │
│                                  │  │   fiscal year, reconciled   │ │
│                                  │  └────────────────────────────┘ │
└───────────────────────────────┴──────────────────────────────┘
```

Left pane is the actual source PDF with the exact quote highlighted, using the same position data extracted
in Phase 1. Right pane shows the fact and every relationship it has, each with the engine's plain-language
explanation, not a bare label. This one screen is effectively your entire pitch, it's worth the most build
time and the most polish.

### 3.5 Relationships

A dedicated view organized by relation type, this is the screen that makes all four required cases browsable
as a set, not just individually pinned.

```
┌────────────────────────────────────────────────────────────┐
│  Relationships    [Corroborated] [Contradicted] [Reconciled] │
│                    [Uncertain]                                │
├────────────────────────────────────────────────────────────┤
│  Corroborated (4)                                             │
│  Acme Corp revenue confirmed across 2 documents     → view    │
│  ...                                                           │
└────────────────────────────────────────────────────────────┘
```

Tabs map directly to `relation_type` in the data model, no separate logic needed, this screen is mostly a
filtered view over the same relationships table already built in Phase 4.

### 3.6 Entities

```
┌────────────────────────────────────────────────────────────┐
│  Entities                                                     │
├────────────────────────────────────────────────────────────┤
│  Acme Corp                                                     │
│    aka: "Acme Corporation" (board_minutes.pdf)                 │
│    aka: "the Company" (press_release.pdf)                      │
│    12 facts across 3 documents                                 │
└────────────────────────────────────────────────────────────┘
```

Exists specifically to make entity resolution (Phase 3) visible on its own, not just implied by facts
lining up correctly elsewhere. A reviewer checking your entity resolution work should be able to see the
aliases directly, not infer that it happened.

## 4. Navigation Flows

**Reviewer flow (the one that matters most)**
Overview → click each Demo Highlights row → land directly on the relevant Fact or Relationship Detail with
evidence and explanation visible → done in under a minute, no hunting.

**First-time / builder flow**
Documents (empty state, prompts upload) → upload a PDF → status visible on Documents screen → once
processed, Facts populates → click into a fact → see relationships forming as more documents are added.

**Exploration flow**
Facts → filter by entity or predicate → open a fact → follow a relationship link to a fact in a different
document → open Entities to see the shared entity's full alias list.

## 5. Visual Language

Using your established palette and type system rather than inventing a new one for this project:
- Palette: olive / near-black / paper.
- Typography: Inter for UI text, JetBrains Mono for values, quotes, and raw extracted text specifically,
  the monospace treatment reinforces that these are literal extracted values, not paraphrased summaries,
  which is a small but real signal reinforcing the grounding claim.
- Status indicators (pending/processing/processed/failed, corroborated/contradicted/reconciled/uncertain)
  should be the only place color carries meaning, everything else stays close to monochrome so the status
  signals stand out rather than compete with decoration.

## 6. Component to Phase Mapping

| Screen | Built in | Depends on |
|---|---|---|
| Documents | Phase 6 | Phase 1 (ingestion), Phase 5 (API) |
| Facts | Phase 6 | Phase 2 (extraction), Phase 5 (API) |
| Fact/Relationship Detail | Phase 6 | Phase 1 (position data), Phase 4 (reconciliation) |
| Relationships (tabbed) | Phase 6 | Phase 4 |
| Entities | Phase 6 | Phase 3 |
| Overview / Demo Highlights | Phase 6, curated last | all of the above, plus Phase 8's failure case |

## 7. Responsive Behavior

Collapse the sidebar to an icon rail below roughly 900px, full hamburger drawer below 600px. This almost
certainly won't matter for the demo video (recorded at desktop width), but costs little to handle and
avoids the UI looking broken if a reviewer happens to resize the window.

## 8. Deliberately Not Building

Consistent with the brief rewarding a small, understandable system: no auth, no multi-user support, no
settings screen, no vanity charts on the Overview beyond the three counts shown. Every screen above exists
because it makes a required case easier to find or verify, nothing is included for the sake of looking more
built-out than it needs to be.