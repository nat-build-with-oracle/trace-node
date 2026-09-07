-- OAuth 2.1, stored in the database that is already here.
--
-- The obvious Cloudflare answer is @cloudflare/workers-oauth-provider backed by
-- a KV namespace. This does not use it, for one concrete reason: the one-click
-- deploy button provisions exactly the bindings wrangler.jsonc declares, and
-- every added binding is another thing that can be missing, unbound, or
-- misconfigured on someone else's account. D1 is already required and already
-- provisioned. Three small tables cost nothing and keep the install one click.
--
-- The shape below is lifted from a version of this that already works in
-- production elsewhere in this fleet (arra-memory-haos/src/oauth.ts). Where it
-- differs, the difference is noted.

-- A client that registered itself. claude.ai does this rather than being
-- configured by hand, which is why Dynamic Client Registration (RFC 7591) is
-- not optional for a server that wants to be a custom connector.
CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id     TEXT PRIMARY KEY,
  client_name   TEXT,
  -- JSON array. Stored whole and compared by EXACT MATCH at authorize time.
  -- Prefix matching here is the classic OAuth open redirect: a client
  -- registered for https://x/cb must not receive a code at https://x/cb.evil.
  redirect_uris TEXT NOT NULL,
  created_at    TEXT NOT NULL
);

-- An authorization code in flight. Lives for one round trip, not a session.
CREATE TABLE IF NOT EXISTS oauth_codes (
  code                  TEXT PRIMARY KEY,
  client_id             TEXT NOT NULL,
  -- Both of these are re-checked at exchange time. The code was issued to ONE
  -- client for ONE redirect_uri, and a code observed in a redirect must not be
  -- redeemable by anyone else.
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL,
  -- S256 only; 'plain' is refused at issue time rather than stored and honoured.
  code_challenge_method TEXT NOT NULL,
  scope                 TEXT NOT NULL,
  -- RFC 8707 resource indicator. Recorded so a token can be bound to the MCP
  -- endpoint it was requested for, rather than being valid for anything that
  -- happens to trust this issuer.
  resource              TEXT,
  -- Epoch seconds, not ISO: this column is only ever compared to a clock.
  expires_at            INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS oauth_codes_expiry_idx ON oauth_codes(expires_at);

-- An access token. No refresh tokens: this is one owner and one corpus, and a
-- 30-day access token with a visible revoke button is easier to reason about
-- than a refresh rotation nobody will audit.
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token      TEXT PRIMARY KEY,
  client_id  TEXT NOT NULL,
  scope      TEXT NOT NULL,
  resource   TEXT,
  created_at TEXT NOT NULL,
  -- NULL means "never expires". Nothing issues that today; the column allows it
  -- so a long-lived machine token does not need a second table.
  expires_at INTEGER
);

CREATE INDEX IF NOT EXISTS oauth_tokens_client_idx ON oauth_tokens(client_id);
CREATE INDEX IF NOT EXISTS oauth_tokens_expiry_idx ON oauth_tokens(expires_at);
