-- A passphrase you can change without a deploy.
--
-- `OWNER_PASSPHRASE` is a Cloudflare secret, injected per request and READ-ONLY
-- to the Worker. A Worker cannot rewrite its own secret, so "change it from the
-- UI" is impossible while the env var is the only source of truth — the only
-- way to rotate was `wrangler secret put`, which needs a terminal and the
-- account it was deployed from.
--
-- So the passphrase moves here, and the env secret becomes the BOOTSTRAP: it is
-- what lets you in on a fresh deploy, and what lets you back in if you forget
-- the one you set. Both work; the stored one takes precedence when present.
--
-- Stored as PBKDF2-SHA256 with a per-row random salt, never as the passphrase
-- and never as a bare SHA-256. A bare digest of a memorable phrase falls to a
-- wordlist in seconds; the iteration count is the whole point of the column.
CREATE TABLE IF NOT EXISTS settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Keys used, so a reader does not have to grep for them:
--   owner_passphrase  -> "pbkdf2$<iterations>$<salt-b64url>$<hash-b64url>"
--
-- Nothing else belongs in here yet. This is deliberately a key/value table and
-- not a settings OBJECT: one row per decision means a later setting is an INSERT
-- rather than a migration, which is the same reason the taxonomy is rows.
