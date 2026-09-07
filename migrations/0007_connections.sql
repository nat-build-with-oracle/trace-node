-- Who has been calling in.
--
-- "How many devices or services are connected, and is claude.ai among them?"
-- is a question neither existing table can answer. `oauth_clients` knows who
-- REGISTERED — a token that exists is not a client that calls. `mcp_calls`
-- knows which tools ran, but a client can hold a session for hours and never
-- call a tool, and the browser and the HA sidebar never call one at all.
--
-- So this is one row per (method, principal), folded on write: counters add,
-- last_* replace, first_seen is kept. It is a projection of the request
-- stream, not a log — the log is mcp_calls, and keeping a row per request here
-- would grow without bound to answer a question about the present.
--
-- Nothing here is a credential. The bearer that proved a caller is discarded at
-- the gate; only the METHOD survives, alongside a user agent and, for ingress,
-- the proxy's own address.
CREATE TABLE IF NOT EXISTS connections (
  -- '<method>:<principal>' — the identity of a caller, not of a request.
  id          TEXT PRIMARY KEY,
  method      TEXT NOT NULL,
  principal   TEXT NOT NULL,
  -- Resolved at write time so a renamed OAuth client shows its current face.
  label       TEXT NOT NULL,
  user_agent  TEXT,
  remote_ip   TEXT,
  first_seen  TEXT NOT NULL,
  last_seen   TEXT NOT NULL,
  requests    INTEGER NOT NULL DEFAULT 0,
  tool_calls  INTEGER NOT NULL DEFAULT 0,
  last_tool   TEXT
);

-- The page always sorts by recency and filters by a time window, so this is the
-- only index the queries need.
CREATE INDEX IF NOT EXISTS connections_last_seen ON connections(last_seen DESC);
