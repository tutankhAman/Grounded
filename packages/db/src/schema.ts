import { pgTable, text, integer, boolean, timestamp, uuid, real, jsonb, vector } from 'drizzle-orm/pg-core';
import { relations } from 'drizzle-orm';

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  filename: text('filename').notNull(),
  filePath: text('file_path').notNull(),
  pageCount: integer('page_count'),
  status: text('status').notNull().default('pending'), // 'pending' | 'parsing' | 'parsed' | 'extracting' | 'extracted' | 'resolving' | 'reconciling' | 'done' | 'failed'
  errorMessage: text('error_message'),
  uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pageChunks = pgTable('page_chunks', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  pageNumber: integer('page_number').notNull(),
  chunkIndex: integer('chunk_index').notNull().default(0),
  rawText: text('raw_text').notNull(),
  isTableHeavy: boolean('is_table_heavy').notNull().default(false),
  imagePath: text('image_path'),
  positionData: jsonb('position_data'), // Array of TextRun items
  tokenEstimate: integer('token_estimate'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const entities = pgTable('entities', {
  id: uuid('id').primaryKey().defaultRandom(),
  canonicalName: text('canonical_name').notNull(),
  entityType: text('entity_type'), // organization, person, place, product, etc.
  contextSample: text('context_sample'),
  embedding: vector('embedding', { dimensions: 1536 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const entityAliases = pgTable('entity_aliases', {
  id: uuid('id').primaryKey().defaultRandom(),
  entityId: uuid('entity_id').notNull().references(() => entities.id, { onDelete: 'cascade' }),
  surfaceForm: text('surface_form').notNull(),
  documentId: uuid('document_id').references(() => documents.id, { onDelete: 'set null' }),
  confidence: real('confidence').default(1.0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const factTypes = pgTable('fact_types', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description').notNull(),
  examplePredicates: jsonb('example_predicates'), // array of predicate strings
  embedding: vector('embedding', { dimensions: 1536 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const facts = pgTable('facts', {
  id: uuid('id').primaryKey().defaultRandom(),
  documentId: uuid('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
  entityId: uuid('entity_id').references(() => entities.id, { onDelete: 'set null' }),
  factTypeId: uuid('fact_type_id').references(() => factTypes.id, { onDelete: 'set null' }),
  predicate: text('predicate').notNull(),
  value: text('value').notNull(),
  rawValue: text('raw_value').notNull(),
  unit: text('unit'),
  currency: text('currency'),
  timeScope: text('time_scope'),
  qualifiers: jsonb('qualifiers'),
  embedding: vector('embedding', { dimensions: 1536 }),
  confidence: real('confidence').notNull().default(1.0),
  sourcePage: integer('source_page').notNull(),
  sourceQuote: text('source_quote').notNull(),
  sourceQuoteValid: boolean('source_quote_valid').default(true),
  extractedAt: timestamp('extracted_at', { withTimezone: true }).notNull().defaultNow(),
});

export const relationships = pgTable('relationships', {
  id: uuid('id').primaryKey().defaultRandom(),
  factAId: uuid('fact_a_id').notNull().references(() => facts.id, { onDelete: 'cascade' }),
  factBId: uuid('fact_b_id').notNull().references(() => facts.id, { onDelete: 'cascade' }),
  relationType: text('relation_type').notNull(), // 'corroborates' | 'contradicts' | 'reconciled' | 'uncertain'
  explanation: text('explanation').notNull(),
  confidence: real('confidence').notNull().default(1.0),
  method: text('method').notNull(), // 'rule' | 'llm_judge' | 'both'
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
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
  entity: one(entities, {
    fields: [entityAliases.entityId],
    references: [entities.id],
  }),
  document: one(documents, {
    fields: [entityAliases.documentId],
    references: [documents.id],
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
  relationshipsAsA: many(relationships, { relationName: 'rel_fact_a' }),
  relationshipsAsB: many(relationships, { relationName: 'rel_fact_b' }),
}));

export const relationshipsRelations = relations(relationships, ({ one }) => ({
  factA: one(facts, {
    fields: [relationships.factAId],
    references: [facts.id],
    relationName: 'rel_fact_a',
  }),
  factB: one(facts, {
    fields: [relationships.factBId],
    references: [facts.id],
    relationName: 'rel_fact_b',
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
