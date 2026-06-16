-- Shared PostgreSQL extensions, installed into the `public` schema so a
-- single copy resolves from every application schema (tables live in
-- DB_SCHEMA, default `auth`, with `public` kept on the search_path).
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;
