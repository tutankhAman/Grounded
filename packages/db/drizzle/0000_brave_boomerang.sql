CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"filename" text NOT NULL,
	"file_path" text NOT NULL,
	"page_count" integer,
	"status" text DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"canonical_name" text NOT NULL,
	"entity_type" text,
	"context_sample" text,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "entity_aliases" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"entity_id" uuid NOT NULL,
	"surface_form" text NOT NULL,
	"document_id" uuid,
	"confidence" real DEFAULT 1,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fact_types" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"example_predicates" jsonb,
	"embedding" vector(1536),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"entity_id" uuid,
	"fact_type_id" uuid,
	"predicate" text NOT NULL,
	"value" text NOT NULL,
	"raw_value" text NOT NULL,
	"unit" text,
	"currency" text,
	"time_scope" text,
	"qualifiers" jsonb,
	"embedding" vector(1536),
	"confidence" real DEFAULT 1 NOT NULL,
	"source_page" integer NOT NULL,
	"source_quote" text NOT NULL,
	"source_quote_valid" boolean DEFAULT true,
	"extracted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "page_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"chunk_index" integer DEFAULT 0 NOT NULL,
	"raw_text" text NOT NULL,
	"is_table_heavy" boolean DEFAULT false NOT NULL,
	"image_path" text,
	"position_data" jsonb,
	"token_estimate" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "relationships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"fact_a_id" uuid NOT NULL,
	"fact_b_id" uuid NOT NULL,
	"relation_type" text NOT NULL,
	"explanation" text NOT NULL,
	"confidence" real DEFAULT 1 NOT NULL,
	"method" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "entity_aliases" ADD CONSTRAINT "entity_aliases_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_entity_id_entities_id_fk" FOREIGN KEY ("entity_id") REFERENCES "public"."entities"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_fact_type_id_fact_types_id_fk" FOREIGN KEY ("fact_type_id") REFERENCES "public"."fact_types"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "page_chunks" ADD CONSTRAINT "page_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_fact_a_id_facts_id_fk" FOREIGN KEY ("fact_a_id") REFERENCES "public"."facts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_fact_b_id_facts_id_fk" FOREIGN KEY ("fact_b_id") REFERENCES "public"."facts"("id") ON DELETE cascade ON UPDATE no action;