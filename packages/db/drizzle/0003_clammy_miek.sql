CREATE UNIQUE INDEX IF NOT EXISTS "entities_canonical_name_lower_idx" ON "entities" USING btree (lower("canonical_name"));--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "relationships_fact_a_b_idx" ON "relationships" USING btree ("fact_a_id","fact_b_id");
