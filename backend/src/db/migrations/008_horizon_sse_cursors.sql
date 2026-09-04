-- Migration 004: Horizon SSE cursor persistence
--
-- Creates the table used by PostgresCursorCache to persist the last-seen
-- Horizon paging_token for each named SSE stream.  This allows the indexer to
-- resume exactly where it left off after a restart or connection drop, avoiding
-- duplicate or missed event processing.

CREATE TABLE IF NOT EXISTS "indexer_cursors" (
    stream_name TEXT    NOT NULL,
    cursor      TEXT    NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT indexer_cursors_pkey PRIMARY KEY (stream_name)
);

COMMENT ON TABLE "indexer_cursors" IS
    'Persisted Horizon SSE paging_token cursors, one row per named stream.';
COMMENT ON COLUMN "indexer_cursors".stream_name IS
    'Logical name of the SSE stream (e.g. ''horizon_sse'' or ''pactum_events'').';
COMMENT ON COLUMN "indexer_cursors".cursor IS
    'Most-recently processed Horizon paging_token for this stream.';
COMMENT ON COLUMN "indexer_cursors".updated_at IS
    'Wall-clock time when this cursor was last updated.';
