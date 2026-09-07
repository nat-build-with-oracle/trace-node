-- THE LOG. One row per read that carried an intent. mcp_calls answers "which tool ran",
-- connections answers "who is here", this answers "what was sought".
CREATE TABLE IF NOT EXISTS traces (
  id           TEXT PRIMARY KEY,                      -- randomToken(16), as nodes/mcp_calls
  at           TEXT NOT NULL,                         -- ISO-8601 UTC from the app clock (§3.2 clock); rowid is the tiebreaker
  kind         TEXT NOT NULL CHECK (kind IN ('search','read','term','category','dig')),
  surface      TEXT NOT NULL CHECK (surface IN ('mcp','http','ui')),
  method       TEXT NOT NULL DEFAULT '',              -- connections.method, no CHECK (dn/src/connections.ts:38 owns the set)
  principal    TEXT NOT NULL DEFAULT '',              -- connections.principal (socket peer for ingress)
  ha_user      TEXT NOT NULL DEFAULT '',              -- X-Remote-User-Id, ingress only, after the peer check (§3.9 #6); visibility §3.10
  subject      TEXT NOT NULL CHECK (subject IN ('keyword','term','node')),
  subject_key  TEXT NOT NULL,                         -- keyword_norm | term.id | node.id
  keyword      TEXT NOT NULL DEFAULT '' CHECK (length(keyword) <= 200),
  keyword_norm TEXT NOT NULL DEFAULT '',
  node_id      TEXT,                                  -- kind='read'
  term_id      TEXT,                                  -- kind='term' | 'category'
  vocabulary   TEXT NOT NULL DEFAULT '',              -- denormalised so a deleted term still explains its rows
  hits         INTEGER NOT NULL DEFAULT 0,
  mode         TEXT NOT NULL DEFAULT '',              -- 'fts' | 'like' | 'semantic' | 'hybrid' | 'list' | ''
  took_ms      INTEGER NOT NULL DEFAULT 0,
  client       TEXT NOT NULL DEFAULT '' CHECK (length(client) <= 120),  -- clientInfo.name || UA family, clipped at write; attacker-controlled, never identity
  dig_seq      INTEGER                                -- no FK: digs and traces are evicted on different clocks
);
CREATE INDEX IF NOT EXISTS traces_at      ON traces(at DESC);                          -- timeline + eviction
CREATE INDEX IF NOT EXISTS traces_subject ON traces(subject, subject_key, at DESC);    -- trace-by-keyword/term/node
CREATE INDEX IF NOT EXISTS traces_kind    ON traces(kind, at DESC);
CREATE INDEX IF NOT EXISTS traces_princ   ON traces(principal, at DESC);

-- THE PROJECTION. Daily buckets, UPSERTed in the same batch as every traces INSERT, NEVER evicted.
-- Without it the `all` cloud and the /api/trace sparkline hollow out after §3.8's 180-day eviction.
-- `day` is the UTC date (the container has no TZ; §9 A.13 keeps the +07 boundary question open).
CREATE TABLE IF NOT EXISTS trace_days (
  subject     TEXT NOT NULL, subject_key TEXT NOT NULL, day TEXT NOT NULL,   -- day = substr(at,1,10)
  reads       INTEGER NOT NULL DEFAULT 0,
  hits        INTEGER NOT NULL DEFAULT 0,
  took_ms     INTEGER NOT NULL DEFAULT 0,
  last_at     TEXT NOT NULL,
  label       TEXT NOT NULL DEFAULT '',   -- last raw keyword spelling; '' for term/node (resolved by JOIN); retained indefinitely (DOCS says so; DELETE /api/trace?q= is the forget path, §3.3)
  PRIMARY KEY (subject, subject_key, day)
);
CREATE INDEX IF NOT EXISTS trace_days_day ON trace_days(day DESC);
