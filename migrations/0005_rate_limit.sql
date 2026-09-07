-- Throttle the passphrase endpoints.
--
-- Every other secret here has real entropy — a 32-byte token, a PKCE verifier,
-- a single-use code burned on the first failed exchange. The owner passphrase
-- is the one a HUMAN chose, and /login and /authorize were willing to be asked
-- about it without limit. The crypto was never the weak link; the guessing
-- budget was.
--
-- One row per (bucket, ip), four columns, no stored deadline: how long a caller
-- waits is derived from `failures` and `last_at`, so there is one rule in one
-- place rather than a timestamp that can disagree with it.
CREATE TABLE IF NOT EXISTS auth_attempts (
  -- 'login' or 'authorize'. Separate budgets, so hammering one door does not
  -- lock the other.
  bucket    TEXT    NOT NULL,
  -- CF-Connecting-IP, which Cloudflare's edge sets and a client cannot forge.
  -- A speed bump, not a perimeter: many addresses means many budgets. It turns
  -- an unlimited online guessing attack into a limited one, which is the whole
  -- difference between a short passphrase falling this afternoon and not at all.
  client_ip TEXT    NOT NULL,
  failures  INTEGER NOT NULL,
  -- Epoch seconds. Both the backoff clock and the staleness clock — a caller who
  -- goes quiet for a window is forgotten, so an old typo never accumulates.
  last_at   INTEGER NOT NULL,
  PRIMARY KEY (bucket, client_ip)
);
