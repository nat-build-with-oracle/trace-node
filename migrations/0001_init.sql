-- digger-node — the whole schema, in one migration.
--
-- Squashed deliberately. The first three migrations were the shape of our
-- LEARNING (nodes, then a call log, then the taxonomy distinction we only found
-- by reading how Drupal actually works) and a new deployment should not have to
-- replay someone else's education. What survives is the conclusion.
--
-- The model, in four nouns Drupal got right in 2004:
--   node        one piece of content: title, body, a datetime
--   vocabulary  a namespace for terms, with a POLICY (see kind, below)
--   term        a label inside a vocabulary, nestable, ordered by weight
--   node_terms  the join — a node wears any number of terms
--
-- Everything is IF NOT EXISTS: a deploy-button retry must never be able to
-- break a corpus that already has rows.

-- ── content ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS nodes (
  id         TEXT PRIMARY KEY,
  -- Drupal's "content type" (article/page/…). Free text, not an enum: a new
  -- type is a string a client picks, never a migration someone has to run.
  type       TEXT NOT NULL DEFAULT 'note',
  title      TEXT NOT NULL,
  body       TEXT NOT NULL DEFAULT '',
  -- ISO-8601 UTC, stored as TEXT: SQLite has no date type, and ISO-8601 sorts
  -- correctly as a string — the cheap thing and the right thing agreeing.
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  -- Drupal's published flag. Unpublishing is the reversible act; DELETE is the
  -- deliberate one.
  status     INTEGER NOT NULL DEFAULT 1,
  author     TEXT NOT NULL DEFAULT '',
  CHECK (length(title) BETWEEN 1 AND 200),
  CHECK (length(body) <= 100000),
  CHECK (status IN (0, 1))
);

CREATE INDEX IF NOT EXISTS nodes_created_idx ON nodes(created_at DESC);
CREATE INDEX IF NOT EXISTS nodes_type_idx    ON nodes(type, created_at DESC);
CREATE INDEX IF NOT EXISTS nodes_status_idx  ON nodes(status, created_at DESC);

-- ── taxonomy ────────────────────────────────────────────────────────────────

-- `kind` is the distinction the first draft of this schema missed, and it is
-- the whole reason to copy Drupal rather than invent a tag column.
--
--   'tags'       FREE-TAGGING. Unknown terms are created on demand. Many,
--                specific, flat, cutting across everything.
--   'categories' CONTROLLED. Terms are added deliberately; tagging with an
--                unknown one FAILS. Few, broad, hierarchical, stable.
--
-- Free-tagging alone is the permissive default and the wrong one for a store a
-- MODEL writes to: an LLM tagging the same idea twice will produce `mcp`, `MCP`
-- and `model-context-protocol` — three rows, one concept, and a taxonomy that
-- has quietly stopped being able to answer "everything about X". A controlled
-- vocabulary is the guard, and the policy belongs to the NAMESPACE, which is
-- exactly where Drupal puts it.
CREATE TABLE IF NOT EXISTS vocabularies (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL UNIQUE,          -- machine name, lowercase slug
  label       TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'tags',
  created_at  TEXT NOT NULL,
  CHECK (length(name) BETWEEN 1 AND 64),
  CHECK (kind IN ('tags', 'categories'))
);

-- parent_id because Drupal's terms are hierarchical, and because a flat tag
-- list cannot express "Bangkok is in Thailand" without inventing a convention
-- on top of the names.
--
-- weight because a vocabulary should have the order its owner chose rather than
-- an alphabetical accident. This is the cheap half of Drupal's Taxonomy Menu
-- module: a menu and a taxonomy answer different questions — "the order I want
-- people to walk through this" versus "what this content is about" — and that
-- module exists because the second can GENERATE the first. With a weight, a
-- controlled vocabulary rendered in weight order IS the menu, and there is no
-- second system to keep in step.
CREATE TABLE IF NOT EXISTS terms (
  id            TEXT PRIMARY KEY,
  vocabulary_id TEXT NOT NULL REFERENCES vocabularies(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  parent_id     TEXT REFERENCES terms(id) ON DELETE SET NULL,
  weight        INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  CHECK (length(name) BETWEEN 1 AND 128)
);

-- One term name per vocabulary. Two vocabularies may both hold "draft".
CREATE UNIQUE INDEX IF NOT EXISTS terms_vocab_name_idx ON terms(vocabulary_id, name);
CREATE INDEX IF NOT EXISTS terms_parent_idx ON terms(parent_id);
CREATE INDEX IF NOT EXISTS terms_weight_idx ON terms(vocabulary_id, weight, name);

-- Drupal calls this a term reference field. It is a join table wearing a costume.
CREATE TABLE IF NOT EXISTS node_terms (
  node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
  term_id TEXT NOT NULL REFERENCES terms(id) ON DELETE CASCADE,
  PRIMARY KEY (node_id, term_id)
);

CREATE INDEX IF NOT EXISTS node_terms_term_idx ON node_terms(term_id);

-- ── full-text search ────────────────────────────────────────────────────────
--
-- tokenize='trigram', and that is not a style choice.
--
-- FTS5's default unicode61 tokenizer splits on whitespace and punctuation. Thai
-- writes without spaces between words, so unicode61 swallows a whole Thai
-- sentence as ONE token and a search for a word inside it returns nothing at
-- all. This exact measurement has been made independently four times across
-- this fleet — it is the single most re-derived finding we have, so it ships as
-- the default rather than being rediscovered a fifth time.
--
-- Costs, stated honestly: ~2-3x storage on the indexed text, and queries under
-- 3 characters cannot use the index (the code falls back to LIKE and SAYS so).
--
-- content='nodes' makes this external-content: the text is not stored twice.
CREATE VIRTUAL TABLE IF NOT EXISTS nodes_fts USING fts5(
  title, body,
  content='nodes',
  content_rowid='rowid',
  tokenize='trigram'
);

-- External-content FTS5 does not follow its source table on its own. Without
-- these three triggers the index drifts silently, which is worse than having no
-- index: searches then return confidently wrong results.
CREATE TRIGGER IF NOT EXISTS nodes_fts_insert AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- 'delete' rows are how FTS5 retracts old terms for external content; a bare
-- UPDATE would leave the previous text matchable forever.
CREATE TRIGGER IF NOT EXISTS nodes_fts_delete AFTER DELETE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
END;

CREATE TRIGGER IF NOT EXISTS nodes_fts_update AFTER UPDATE ON nodes BEGIN
  INSERT INTO nodes_fts(nodes_fts, rowid, title, body) VALUES ('delete', old.rowid, old.title, old.body);
  INSERT INTO nodes_fts(rowid, title, body) VALUES (new.rowid, new.title, new.body);
END;

-- ── the call log ────────────────────────────────────────────────────────────
--
-- Every MCP tool call, with what went in and what came back — successes and
-- failures both, because a call that errored is the one you most want to read
-- later. An MCP server you cannot watch is one you are trusting on faith:
-- "the model said it saved that" is not evidence a row exists.
CREATE TABLE IF NOT EXISTS mcp_calls (
  id          TEXT PRIMARY KEY,
  called_at   TEXT NOT NULL,
  tool        TEXT NOT NULL,
  -- JSON as sent by the client, truncated at WRITE time — a 100KB argument blob
  -- would otherwise live here forever and only be trimmed when someone reads it.
  input       TEXT NOT NULL DEFAULT '',
  outcome     TEXT NOT NULL DEFAULT 'ok',
  result      TEXT NOT NULL DEFAULT '',
  duration_ms INTEGER NOT NULL DEFAULT 0,
  -- Whatever the client volunteered (clientInfo.name, else User-Agent). A
  -- label, never identity — nothing authenticates here.
  client      TEXT NOT NULL DEFAULT '',
  CHECK (outcome IN ('ok', 'error'))
);

CREATE INDEX IF NOT EXISTS mcp_calls_time_idx    ON mcp_calls(called_at DESC);
CREATE INDEX IF NOT EXISTS mcp_calls_tool_idx    ON mcp_calls(tool, called_at DESC);
CREATE INDEX IF NOT EXISTS mcp_calls_outcome_idx ON mcp_calls(outcome, called_at DESC);
