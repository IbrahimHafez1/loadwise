-- Store search (ILIKE %term%) is served by a trigram index the schema cannot express.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX "Store_name_trgm_idx" ON "Store" USING gin ("name" gin_trgm_ops);
