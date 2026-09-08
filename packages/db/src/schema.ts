import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  vector,
} from "drizzle-orm/pg-core";

// Standardized embedding dimension matching EMBEDDING_DIM env var (gemini-embedding-001 MRL 1536)
export const EMBEDDING_DIM = 1536;

export const documents = pgTable("documents", {
  errorMessage: text("error_message"),
  filename: text("filename").notNull(),
  filePath: text("file_path").notNull(),
  id: uuid("id").primaryKey().defaultRandom(),
  pageCount: integer("page_count"),
  status: text("status").notNull().default("pending"), // 'pending' | 'parsing' | 'parsed' | 'extracting' | 'extracted' | 'resolving' | 'resolved' | 'reconciling' | 'done' | 'failed'
  uploadedAt: timestamp("uploaded_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const pageChunks = pgTable(
  "page_chunks",
  {
    chunkIndex: integer("chunk_index").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    extractionStatus: text("extraction_status").notNull().default("pending"), // 'pending' | 'extracted' | 'extraction_failed' | 'extraction_deferred'
    id: uuid("id").primaryKey().defaultRandom(),
    imagePath: text("image_path"),
    isLowText: boolean("is_low_text").notNull().default(false),
    isTableHeavy: boolean("is_table_heavy").notNull().default(false),
    needsVision: boolean("needs_vision").notNull().default(false),
    pageNumber: integer("page_number").notNull(),
    positionData: jsonb("position_data"), // Array of TextRun items
    rawText: text("raw_text").notNull(),
    tokenEstimate: integer("token_estimate"),
  },
  (table) => [
    uniqueIndex("page_chunks_doc_page_chunk_idx").on(
      table.documentId,
      table.pageNumber,
      table.chunkIndex
    ),
  ]
);

export const entities = pgTable(
  "entities",
  {
    canonicalName: text("canonical_name").notNull(),
    contextSample: text("context_sample"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    entityType: text("entity_type"), // organization, person, place, product, etc.
    id: uuid("id").primaryKey().defaultRandom(),
  },
  (table) => [
    uniqueIndex("entities_canonical_name_lower_idx").on(
      sql`lower(${table.canonicalName})`
    ),
  ]
);

export const entityAliases = pgTable("entity_aliases", {
  confidence: real("confidence").default(1.0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  documentId: uuid("document_id").references(() => documents.id, {
    onDelete: "set null",
  }),
  entityId: uuid("entity_id")
    .notNull()
    .references(() => entities.id, { onDelete: "cascade" }),
  id: uuid("id").primaryKey().defaultRandom(),
  surfaceForm: text("surface_form").notNull(),
});

export const factTypes = pgTable("fact_types", {
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  description: text("description").notNull(),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
  examplePredicates: jsonb("example_predicates"), // array of predicate strings
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
});

export const facts = pgTable(
  "facts",
  {
    confidence: real("confidence").notNull().default(1.0),
    currency: text("currency"),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    embedding: vector("embedding", { dimensions: EMBEDDING_DIM }),
    entityId: uuid("entity_id").references(() => entities.id, {
      onDelete: "set null",
    }),
    extractedAt: timestamp("extracted_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    factTypeId: uuid("fact_type_id").references(() => factTypes.id, {
      onDelete: "set null",
    }),
    id: uuid("id").primaryKey().defaultRandom(),
    predicate: text("predicate").notNull(),
    qualifiers: jsonb("qualifiers"),
    rawValue: text("raw_value").notNull(),
    sourceChunkIndex: integer("source_chunk_index").notNull().default(0),
    sourcePage: integer("source_page").notNull(),
    sourceQuote: text("source_quote").notNull(),
    sourceQuoteValid: boolean("source_quote_valid").default(true),
    timeScope: text("time_scope"),
    unit: text("unit"),
    value: text("value").notNull(),
  },
  (table) => [
    index("facts_doc_page_chunk_idx").on(
      table.documentId,
      table.sourcePage,
      table.sourceChunkIndex
    ),
  ]
);

export const relationships = pgTable("relationships", {
  confidence: real("confidence").notNull().default(1.0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  explanation: text("explanation").notNull(),
  factAId: uuid("fact_a_id")
    .notNull()
    .references(() => facts.id, { onDelete: "cascade" }),
  factBId: uuid("fact_b_id")
    .notNull()
    .references(() => facts.id, { onDelete: "cascade" }),
  id: uuid("id").primaryKey().defaultRandom(),
  method: text("method").notNull(), // 'rule' | 'llm_judge' | 'both'
  relationType: text("relation_type").notNull(), // 'corroborates' | 'contradicts' | 'reconciled' | 'uncertain'
});

// Relations definitions
export const documentsRelations = relations(documents, ({ many }) => ({
  chunks: many(pageChunks),
  facts: many(facts),
}));

export const pageChunksRelations = relations(pageChunks, ({ one }) => ({
  document: one(documents, {
    fields: [pageChunks.documentId],
    references: [documents.id],
  }),
}));

export const entitiesRelations = relations(entities, ({ many }) => ({
  aliases: many(entityAliases),
  facts: many(facts),
}));

export const entityAliasesRelations = relations(entityAliases, ({ one }) => ({
  document: one(documents, {
    fields: [entityAliases.documentId],
    references: [documents.id],
  }),
  entity: one(entities, {
    fields: [entityAliases.entityId],
    references: [entities.id],
  }),
}));

export const factsRelations = relations(facts, ({ one, many }) => ({
  document: one(documents, {
    fields: [facts.documentId],
    references: [documents.id],
  }),
  entity: one(entities, {
    fields: [facts.entityId],
    references: [entities.id],
  }),
  factType: one(factTypes, {
    fields: [facts.factTypeId],
    references: [factTypes.id],
  }),
  relationshipsAsA: many(relationships, { relationName: "rel_fact_a" }),
  relationshipsAsB: many(relationships, { relationName: "rel_fact_b" }),
}));

export const relationshipsRelations = relations(relationships, ({ one }) => ({
  factA: one(facts, {
    fields: [relationships.factAId],
    references: [facts.id],
    relationName: "rel_fact_a",
  }),
  factB: one(facts, {
    fields: [relationships.factBId],
    references: [facts.id],
    relationName: "rel_fact_b",
  }),
}));

export type Document = typeof documents.$inferSelect;
export type NewDocument = typeof documents.$inferInsert;
export type PageChunk = typeof pageChunks.$inferSelect;
export type NewPageChunk = typeof pageChunks.$inferInsert;
export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
export type EntityAlias = typeof entityAliases.$inferSelect;
export type NewEntityAlias = typeof entityAliases.$inferInsert;
export type FactType = typeof factTypes.$inferSelect;
export type NewFactType = typeof factTypes.$inferInsert;
export type Fact = typeof facts.$inferSelect;
export type NewFact = typeof facts.$inferInsert;
export type Relationship = typeof relationships.$inferSelect;
export type NewRelationship = typeof relationships.$inferInsert;
