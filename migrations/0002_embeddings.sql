-- Semantic search, added deliberately and kept at arm's length.
--
-- Vectors live in their OWN table, not a column on nodes. Three reasons, all of
-- them scars from elsewhere in this fleet:
--
--   1. Embedding is a SECOND PHASE. Importing content must never wait for a
--      model, and a node written while the embedder is down must still be a
--      complete node. A separate table makes "not embedded yet" the natural
--      state instead of a NULL column everyone forgets to check.
--
--   2. A vector is only meaningful inside the SPACE that produced it. Two
--      deployments of the SAME model (bge-m3 via Ollama vs via Workers AI) are
--      still separate spaces — measured in this fleet, and the reason that run
--      pins a revision hash per store. So `model` and `dim` are stored per row
--      and every query filters on them. Mixing spaces returns confident
--      nonsense with no error, which is the worst failure mode there is.
--
--   3. Re-embedding must be detectable. `text_hash` is the hash of exactly the
--      text that was embedded, so an edited node's stale vector is visible
--      rather than silently wrong. arra-memory shipped a bug where `revise`
--      left a stale vector that the backfill predicate could never reach.
CREATE TABLE IF NOT EXISTS node_vectors (
  node_id     TEXT PRIMARY KEY REFERENCES nodes(id) ON DELETE CASCADE,
  -- The space. Not just the model name: the deployment that produced it.
  model       TEXT NOT NULL,
  dim         INTEGER NOT NULL,
  -- Float32 little-endian, dim * 4 bytes. D1 has no native vector type, so the
  -- cosine is computed in the Worker — fine at this corpus size, and the fleet
  -- measured the brute-force/ANN crossover at 2K-20K vectors.
  vector      BLOB NOT NULL,
  -- sha-256 of the exact text embedded. A node whose text no longer hashes to
  -- this has a STALE vector, and stale is a state you can query for.
  text_hash   TEXT NOT NULL,
  embedded_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS node_vectors_model_idx ON node_vectors(model, dim);
