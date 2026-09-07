CREATE TABLE IF NOT EXISTS digs (
  dig_seq      INTEGER PRIMARY KEY AUTOINCREMENT,     -- the fix for the ralph registry's duplicated/null seqs
  at           TEXT NOT NULL,
  keyword      TEXT NOT NULL, keyword_norm TEXT NOT NULL,
  method       TEXT NOT NULL DEFAULT '', principal TEXT NOT NULL DEFAULT '', ha_user TEXT NOT NULL DEFAULT '',
  friction     REAL NOT NULL CHECK (friction BETWEEN 0 AND 1),
  confidence   TEXT NOT NULL CHECK (confidence IN ('high','medium','low')),
  counts       TEXT NOT NULL DEFAULT '{}',   -- {"terms":n,"categories":n,"nodes_fts":n,"nodes_graph":n,"nodes_vector":n|null,"traces":n,"calls":n,"related":n,"prior_digs":n}
  top          TEXT NOT NULL DEFAULT '[]',   -- first 5 items [{source,id,score}] so a dig is recallable after its raw traces are gone
  took_ms      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS digs_kw ON digs(keyword_norm, at DESC);

-- Carry-forward: mcp_calls.client is "never identity" (dn/migrations/0001_init.sql:161-163); the gate knows
-- method:principal, so the audit log can now attribute a call. ADD COLUMN … NOT NULL DEFAULT is a
-- metadata-only change in SQLite — no table rewrite (verified on bun 1.3.14 / SQLite 3.51.0 tonight,
-- scratchpad/mc.ts; not timed on a 100 k-row table, §10).
ALTER TABLE mcp_calls ADD COLUMN method    TEXT NOT NULL DEFAULT '';
ALTER TABLE mcp_calls ADD COLUMN principal TEXT NOT NULL DEFAULT '';
