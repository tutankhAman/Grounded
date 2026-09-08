ALTER TABLE "page_chunks" ADD COLUMN "is_low_text" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "page_chunks" ADD COLUMN "needs_vision" boolean DEFAULT false NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "page_chunks_doc_page_chunk_idx" ON "page_chunks" USING btree ("document_id","page_number","chunk_index");