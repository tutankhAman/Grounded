ALTER TABLE "facts" ADD COLUMN "source_chunk_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "page_chunks" ADD COLUMN "extraction_status" text DEFAULT 'pending' NOT NULL;--> statement-breakpoint
CREATE INDEX "facts_doc_page_chunk_idx" ON "facts" USING btree ("document_id","source_page","source_chunk_index");