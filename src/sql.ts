/**
 * Every SQL statement in this Worker, in one file, as named constants.
 *
 * Nothing else in the codebase writes SQL. That is the whole point: the
 * complete surface that touches the database can be read top to bottom in one
 * sitting, which is what makes it auditable — and it means swapping D1 for any
 * other SQLite is a change of transport, not of behaviour.
 *
 * Every statement is parameterised with `?`. The only interpolation permitted
 * anywhere in this file is the composable fragments at the bottom, which build
 * WHERE/JOIN clauses out of THIS FILE'S OWN string literals and never out of
 * caller input — caller values always arrive as bind arguments.
 *
 * The schema itself is not here: it lives in migrations/, because D1 applies
 * migrations and tracks which ones ran. Duplicating CREATE TABLE here would
 * create two truths about the same tables.
 */

export const NODES = {
  insert: `INSERT INTO nodes (id, type, title, body, created_at, updated_at, status, author)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

  byId: `SELECT * FROM nodes WHERE id = ?`,

  /** Every column is written; the caller merges with the existing row first, so
   *  "only the fields you pass move" is enforced above, not in SQL. */
  update: `UPDATE nodes SET type = ?, title = ?, body = ?, status = ?, author = ?, updated_at = ?
           WHERE id = ?`,

  delete: `DELETE FROM nodes WHERE id = ?`,

  count: `SELECT COUNT(*) AS c FROM nodes`,

  /** Trigram FTS. bm25() ascends — lower is better — so no ORDER BY DESC here. */
  searchFts: `SELECT n.* FROM nodes_fts f
              JOIN nodes n ON n.rowid = f.rowid
              WHERE nodes_fts MATCH ?
              ORDER BY bm25(nodes_fts)
              LIMIT ?`,

  /** The fallback when the needle is under 3 chars, or FTS5 is unavailable. */
  searchLike: `SELECT * FROM nodes
               WHERE title LIKE ? OR body LIKE ?
               ORDER BY created_at DESC, rowid DESC
               LIMIT ?`,
} as const;

export const VOCABULARIES = {
  insert: `INSERT INTO vocabularies (id, name, label, description, kind, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
  byId: `SELECT * FROM vocabularies WHERE id = ?`,
  byName: `SELECT * FROM vocabularies WHERE name = ?`,
  list: `SELECT * FROM vocabularies ORDER BY name`,

  /**
   * What a delete would destroy, so it can be reported BEFORE it happens.
   *
   * `terms.vocabulary_id` and `node_terms.term_id` both cascade (0001_init.sql),
   * so removing a vocabulary silently takes every term in it and every tag
   * assignment those terms carried. That is a lot of work to lose to a typo.
   * args: vocabularyId
   */
  impact: `SELECT
             (SELECT COUNT(*) FROM terms WHERE vocabulary_id = ?1) AS terms,
             (SELECT COUNT(*) FROM node_terms nt
                JOIN terms t ON t.id = nt.term_id
               WHERE t.vocabulary_id = ?1) AS assignments`,

  // args: vocabularyId
  delete: `DELETE FROM vocabularies WHERE id = ?`,
} as const;

export const TERMS = {
  insert: `INSERT INTO terms (id, vocabulary_id, name, description, parent_id, weight, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
  byId: `SELECT * FROM terms WHERE id = ?`,
  byVocabAndName: `SELECT * FROM terms WHERE vocabulary_id = ? AND name = ?`,

  // weight first, name second — the owner's chosen order, then a stable
  // tiebreaker. This is what lets a controlled vocabulary render as a menu.
  //
  // `usage` is the count of nodes wearing the term. LEFT JOIN, not JOIN: a term
  // with no nodes must still appear (as 0), or a freshly created vocabulary
  // looks broken. It is what makes a tag CLOUD possible — a cloud whose sizes
  // do not encode usage is just a list with inconsistent typography.
  list: `SELECT t.*, v.name AS vocabulary, v.kind AS vocabulary_kind,
                COUNT(nt.node_id) AS usage
         FROM terms t
         JOIN vocabularies v ON v.id = t.vocabulary_id
         LEFT JOIN node_terms nt ON nt.term_id = t.id
         GROUP BY t.id
         ORDER BY v.name, t.weight, t.name`,

  listInVocabulary: `SELECT t.*, v.name AS vocabulary, v.kind AS vocabulary_kind,
                            COUNT(nt.node_id) AS usage
                     FROM terms t
                     JOIN vocabularies v ON v.id = t.vocabulary_id
                     LEFT JOIN node_terms nt ON nt.term_id = t.id
                     WHERE v.name = ?
                     GROUP BY t.id
                     ORDER BY t.weight, t.name`,

  setWeight: `UPDATE terms SET weight = ? WHERE id = ?`,
} as const;

export const NODE_TERMS = {
  /** OR IGNORE makes tagging idempotent — tagging twice is not an error. */
  tag: `INSERT OR IGNORE INTO node_terms (node_id, term_id) VALUES (?, ?)`,
  untag: `DELETE FROM node_terms WHERE node_id = ? AND term_id = ?`,
  forNode: `SELECT t.*, v.name AS vocabulary FROM node_terms nt
            JOIN terms t ON t.id = nt.term_id
            JOIN vocabularies v ON v.id = t.vocabulary_id
            WHERE nt.node_id = ?
            ORDER BY v.name, t.name`,
} as const;

export const VECTORS = {
  /** Replace: re-embedding a node overwrites its vector in the same space. */
  upsert: `INSERT INTO node_vectors (node_id, model, dim, vector, text_hash, embedded_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(node_id) DO UPDATE SET
             model = excluded.model, dim = excluded.dim, vector = excluded.vector,
             text_hash = excluded.text_hash, embedded_at = excluded.embedded_at`,

  /** Every vector IN ONE SPACE, with its node. Filtering on (model, dim) is not
   *  optional — a vector from another space is not comparable, and comparing it
   *  anyway returns confident nonsense with no error. */
  allInSpace: `SELECT n.*, v.vector, v.text_hash FROM node_vectors v
               JOIN nodes n ON n.id = v.node_id
               WHERE v.model = ? AND v.dim = ?`,

  /** Nodes with no vector in this space, oldest first — the backfill queue. */
  missing: `SELECT n.* FROM nodes n
            LEFT JOIN node_vectors v ON v.node_id = n.id AND v.model = ?
            WHERE v.node_id IS NULL
            ORDER BY n.created_at ASC
            LIMIT ?`,

  /** Coverage, which most tools in this fleet forget to report — and a Thai
   *  query once scored zero purely because its rows were not embedded yet. */
  coverage: `SELECT
               (SELECT COUNT(*) FROM nodes) AS nodes,
               (SELECT COUNT(*) FROM node_vectors WHERE model = ?) AS embedded,
               (SELECT COUNT(DISTINCT model) FROM node_vectors) AS spaces`,

  /** Vectors whose node text has changed since embedding — stale, not wrong. */
  stale: `SELECT n.id, n.title FROM node_vectors v JOIN nodes n ON n.id = v.node_id
          WHERE v.model = ? AND v.text_hash <> ?`,

  deleteForNode: `DELETE FROM node_vectors WHERE node_id = ?`,
} as const;

export const CALLS = {
  // method/principal (0009): the gate's identity, so the audit log attributes
  // a call. `client` stays what the caller volunteered — never identity.
  insert: `INSERT INTO mcp_calls (id, called_at, tool, input, outcome, result, duration_ms, client, method, principal)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  stats: `SELECT tool,
                 COUNT(*) AS calls,
                 SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END) AS errors,
                 CAST(AVG(duration_ms) AS INTEGER) AS avg_ms,
                 MAX(called_at) AS last_called
          FROM mcp_calls
          GROUP BY tool
          ORDER BY calls DESC`,
} as const;

export const TYPES = {
  /**
   * Content types are DERIVED, not a table — `SELECT DISTINCT type` is the whole
   * registry. Same reasoning as workspace/project elsewhere in this fleet: a
   * type exists the moment a node names it and stops existing when the last one
   * goes, with nothing to keep in step. The drift risk that creates is handled
   * by the optional controlled vocabulary, not by a second table.
   */
  list: `SELECT type, COUNT(*) AS count, MAX(created_at) AS newest
         FROM nodes GROUP BY type ORDER BY count DESC, type`,
} as const;

export const STATS = {
  nodes: `SELECT COUNT(*) AS total,
                 SUM(status) AS published,
                 MIN(created_at) AS oldest,
                 MAX(created_at) AS newest
          FROM nodes`,

  byType: `SELECT type, COUNT(*) AS count FROM nodes GROUP BY type ORDER BY count DESC`,

  vocabularies: `SELECT v.name, COUNT(t.id) AS terms
                 FROM vocabularies v
                 LEFT JOIN terms t ON t.vocabulary_id = v.id
                 GROUP BY v.id
                 ORDER BY v.name`,
} as const;

/**
 * OAuth 2.1. Three tables, no ORM, no KV namespace.
 *
 * `expires_at` is epoch SECONDS everywhere in this block, while the rest of the
 * schema uses ISO strings. That is deliberate and not drift: these columns are
 * only ever compared against a clock, never displayed or sorted next to a
 * node's `created_at`, and an integer comparison cannot be defeated by a
 * timezone suffix the way a string one can.
 */
export const OAUTH = {
  clients: {
    // args: clientId, clientName, redirectUrisJson, createdAt
    register: `INSERT INTO oauth_clients (client_id, client_name, redirect_uris, created_at)
               VALUES (?, ?, ?, ?)`,

    // args: clientId
    byId: `SELECT client_id, client_name, redirect_uris, created_at
             FROM oauth_clients WHERE client_id = ?`,

    /** Who has ever connected, with how many tokens are live right now.
     *  LEFT JOIN so "registered once, nothing active" still shows — that is
     *  information, not an empty row.  args: nowSeconds */
    list: `SELECT c.client_id, c.client_name, c.created_at,
                  COUNT(t.token_hash) AS active_tokens,
                  MAX(t.created_at) AS last_token_at
             FROM oauth_clients c
             LEFT JOIN oauth_tokens t
               ON t.client_id = c.client_id
              AND (t.expires_at IS NULL OR t.expires_at > ?)
            GROUP BY c.client_id
            ORDER BY c.created_at DESC`,
  },

  codes: {
    // args: codeHash, clientId, redirectUri, challenge, method, scope, resource, expiresAt
    issue: `INSERT INTO oauth_codes
              (code_hash, client_id, redirect_uri, code_challenge,
               code_challenge_method, scope, resource, expires_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,

    // args: codeHash, nowSeconds
    consume: `SELECT code_hash, client_id, redirect_uri, code_challenge,
                     code_challenge_method, scope, resource, expires_at
                FROM oauth_codes
               WHERE code_hash = ? AND expires_at > ?`,

    /** Single-use. The caller deletes on EVERY exchange attempt, successful or
     *  not — otherwise an intercepted code grants unlimited guesses at the
     *  verifier.  args: codeHash */
    delete: `DELETE FROM oauth_codes WHERE code_hash = ?`,

    // args: nowSeconds
    sweep: `DELETE FROM oauth_codes WHERE expires_at <= ?`,

    // args: clientId
    deleteForClient: `DELETE FROM oauth_codes WHERE client_id = ?`,

    /** Revoke-all (PRD §3.3, 1b-4): every in-flight code, whatever the client. */
    deleteAll: `DELETE FROM oauth_codes`,
  },

  tokens: {
    // args: tokenHash, clientId, scope, resource, createdAt, expiresAt|null
    issue: `INSERT INTO oauth_tokens (token_hash, client_id, scope, resource, created_at, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)`,

    // args: tokenHash, nowSeconds
    verify: `SELECT token_hash, client_id, scope, resource, created_at, expires_at
               FROM oauth_tokens
              WHERE token_hash = ?
                AND (expires_at IS NULL OR expires_at > ?)`,

    // args: tokenHash
    revoke: `DELETE FROM oauth_tokens WHERE token_hash = ?`,

    // args: clientId
    revokeForClient: `DELETE FROM oauth_tokens WHERE client_id = ?`,

    // args: nowSeconds
    sweep: `DELETE FROM oauth_tokens WHERE expires_at IS NOT NULL AND expires_at <= ?`,

    /** Revoke-all (PRD §3.3, §6.5): every token of every client; the
     *  registrations in `oauth_clients` are untouched, as `revokeForClient`
     *  leaves them. args: none */
    revokeAll: `DELETE FROM oauth_tokens`,
  },
} as const;

/** Throttling for the two endpoints that take a human-chosen passphrase.
 *  `last_at` is epoch SECONDS, like the OAuth expiries — only ever compared to
 *  a clock. */
export const RATE = {
  // args: bucket, clientIp
  get: `SELECT failures, last_at FROM auth_attempts WHERE bucket = ? AND client_ip = ?`,

  /** One failure, resetting the count when the caller has been quiet for a
   *  whole window. Resetting HERE rather than sweeping on a schedule means a
   *  caller who returns an hour later starts clean with nothing having had to
   *  run in between.  args: bucket, clientIp, now, windowStart, now */
  fail: `INSERT INTO auth_attempts (bucket, client_ip, failures, last_at)
         VALUES (?, ?, 1, ?)
         ON CONFLICT(bucket, client_ip) DO UPDATE SET
           failures = CASE WHEN auth_attempts.last_at < ? THEN 1 ELSE auth_attempts.failures + 1 END,
           last_at  = ?`,

  /** A correct passphrase clears the record — mistyping twice then succeeding
   *  must not carry those failures forward.  args: bucket, clientIp */
  clear: `DELETE FROM auth_attempts WHERE bucket = ? AND client_ip = ?`,
} as const;

/** Key/value settings. One row per decision, so adding a setting is an INSERT
 *  rather than a migration — the same reason taxonomy is rows. */
export const SETTINGS = {
  get: `SELECT value FROM settings WHERE key = ?`,
  // args: key, value, updatedAt
  put: `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  delete: `DELETE FROM settings WHERE key = ?`,
} as const;

/**
 * The corpus as one chronology.
 *
 * Two kinds of event — a node was written, a tool was called — interleaved and
 * ordered by EVENT TIME, which is the whole point: neither table alone shows the
 * shape of a working session, and reading either one by insertion order is how
 * you get a timeline that quietly lies.
 *
 * `ORDER BY at DESC, rowid DESC` and not `ORDER BY at DESC` alone. This project
 * has already had a same-millisecond collision produce non-deterministic order
 * in a list, caught by a test rather than by reasoning. Wall-clock time is not a
 * unique key at machine speed, so the insertion counter is the tiebreaker.
 *
 * args: limit
 */
export const TIMELINE = {
  recent: `SELECT * FROM (
             SELECT 'node' AS kind, n.id AS id, n.created_at AS at,
                    n.title AS label, n.type AS detail, NULL AS outcome,
                    NULL AS duration_ms, n.rowid AS seq
               FROM nodes n
             UNION ALL
             SELECT 'call' AS kind, c.id AS id, c.called_at AS at,
                    c.tool AS label, c.client AS detail, c.outcome AS outcome,
                    c.duration_ms AS duration_ms, c.rowid AS seq
               FROM mcp_calls c
             UNION ALL
             SELECT 'trace' AS kind, t.id AS id, t.at AS at,
                    t.keyword AS label, t.kind AS detail, NULL AS outcome,
                    t.took_ms AS duration_ms, t.rowid AS seq
               FROM traces t
           )
           ORDER BY at DESC, seq DESC
           LIMIT ?`,
} as const;

/**
 * The trace log and its projection (PRD §3.1, §3.2).
 *
 * Two statements, always run as ONE batch: the raw row and the day bucket it
 * folds into. The bucket is what survives eviction — `traces` rows go after
 * 180 days, `trace_days` never — so a write that landed one without the other
 * would leave the cloud and the raw log disagreeing about the same read.
 */
export const TRACES = {
  // args: id, at, kind, surface, method, principal, haUser, subject, subjectKey,
  //       keyword, keywordNorm, nodeId|null, termId|null, vocabulary, hits, mode,
  //       tookMs, client, digSeq|null
  insert: `INSERT INTO traces
             (id, at, kind, surface, method, principal, ha_user, subject, subject_key,
              keyword, keyword_norm, node_id, term_id, vocabulary, hits, mode, took_ms, client, dig_seq)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,

  /** `day` is bound from `at` in SQL, so the raw row and its bucket can never
   *  disagree about which date a read belongs to.
   *  args: subject, subjectKey, at, hits, tookMs, at, label */
  upsertDay: `INSERT INTO trace_days (subject, subject_key, day, reads, hits, took_ms, last_at, label)
              VALUES (?, ?, substr(?, 1, 10), 1, ?, ?, ?, ?)
              ON CONFLICT(subject, subject_key, day) DO UPDATE SET
                reads   = reads + 1,
                hits    = hits + excluded.hits,
                took_ms = took_ms + excluded.took_ms,
                last_at = excluded.last_at,
                label   = CASE WHEN excluded.label <> '' THEN excluded.label ELSE label END`,

  count: `SELECT COUNT(*) AS c FROM traces`,
  // args: sinceIso
  countSince: `SELECT COUNT(*) AS c FROM traces WHERE at >= ?`,
  countDigs: `SELECT COUNT(*) AS c FROM digs`,

  /**
   * Forget one keyword (PRD §3.3 `DELETE /api/trace?q=`, §3.10): the raw
   * rows, the day buckets that would otherwise keep its label forever, and
   * the digs it seeded. Three statements, one batch, all keyed on the
   * normalised spelling — `keyword_norm` is what a trace remembers a keyword
   * under, so "MCP", "mcp " and "mcp*" go together. args: keywordNorm
   */
  forgetTraces: `DELETE FROM traces WHERE subject = 'keyword' AND subject_key = ?`,
  forgetDays: `DELETE FROM trace_days WHERE subject = 'keyword' AND subject_key = ?`,
  forgetDigs: `DELETE FROM digs WHERE keyword_norm = ?`,
} as const;

export const TRACE_WHERE = {
  kind: `kind = ?`,
  since: `at >= ?`,
} as const;

// ── the cloud (PRD §3.5) ─────────────────────────────────────────────────────
//
// digger's measured log law, widened to count reads beside usage, and the
// decay computed IN SQL: bun's SQLite ships power() and ln(), so the day
// buckets are weighted where they live rather than shipped to JS and folded
// there. Every window is computed from `trace_days` (day granularity):
// "24h" is today's bucket plus yesterday's × 0.5, not a rolling day — and the
// response says `granularity: "day"` so nobody mistakes it for one.
//
// Bound as ?NNN so every arm reads the same five values:
//   ?1 today (YYYY-MM-DD, from the app clock)   ?2 half-life in days
//   ?3 cutoff day (inclusive)                    ?4 include_empty (1/0)
//   ?5 limit
// A window of `all` uses the flat fragments and leaves ?1–?3 unread.

export type CloudWindow = "24h" | "7d" | "all";
export type CloudBy = "term" | "category" | "keyword" | "all";

const CLOUD_DECAY = {
  // julianday of the DAY, both sides: a bucket one day old at H=1 is exactly
  // 0.5, which is the sentence the PRD uses to describe the 24h window.
  decayed: `power(0.5, (julianday(?1) - julianday(b.day)) / ?2)`,
  flat: `1.0`,
} as const;

const CLOUD_WITHIN = {
  bounded: `b.day >= ?3`,
  all: `1 = 1`,
} as const;

/** Every term and its descendants, so a category's reads roll up (PRD §3.5). */
const TERM_TREE = `tree(root, id, depth) AS (
    SELECT id, id, 0 FROM terms
    UNION ALL
    SELECT tree.root, c.id, tree.depth + 1 FROM terms c JOIN tree ON c.parent_id = tree.id
    WHERE tree.depth < 32
  )`;

/** Distinct nodes wearing a term — digger's `usage`, the cloud's other half. */
const USAGE_OF_TERM = `(SELECT COUNT(DISTINCT nt.node_id) FROM node_terms nt WHERE nt.term_id = t.id)`;

const cloudArms = (decay: string, within: string) => ({
  // Free tags: the term's own buckets PLUS the keyword buckets spelt like its
  // name — a search for "mcp" is a read of the term "MCP" (evolve §7.3).
  // lower(trim()) on the term side because keyword keys are normalised and
  // `createTerm` stores the name as typed; SQLite's lower() is ASCII-only,
  // which is the known miss PRD §9 B records.
  term: `SELECT 'term' AS kind, 'term' AS subject, t.id AS key, t.id AS id, t.name AS label,
                v.name AS vocabulary, ${USAGE_OF_TERM} AS usage,
                COALESCE(SUM(b.reads * ${decay}), 0) AS reads,
                COALESCE(SUM(b.hits), 0) AS hits,
                MAX(b.last_at) AS last
           FROM terms t
           JOIN vocabularies v ON v.id = t.vocabulary_id
           LEFT JOIN trace_days b
             ON ${within}
            AND ((b.subject = 'term' AND b.subject_key = t.id)
              OR (b.subject = 'keyword' AND b.subject_key = lower(trim(t.name))))
          WHERE v.kind = 'tags'
          GROUP BY t.id`,
  // Controlled vocabularies: a read of any descendant is a read of the parent.
  category: `SELECT 'category' AS kind, 'term' AS subject, t.id AS key, t.id AS id, t.name AS label,
                    v.name AS vocabulary, ${USAGE_OF_TERM} AS usage,
                    COALESCE(SUM(b.reads * ${decay}), 0) AS reads,
                    COALESCE(SUM(b.hits), 0) AS hits,
                    MAX(b.last_at) AS last
               FROM terms t
               JOIN vocabularies v ON v.id = t.vocabulary_id
               LEFT JOIN trace_days b
                 ON ${within}
                AND ((b.subject = 'term' AND b.subject_key IN (SELECT id FROM tree WHERE root = t.id))
                  OR (b.subject = 'keyword' AND b.subject_key = lower(trim(t.name))))
              WHERE v.kind = 'categories'
              GROUP BY t.id`,
  // Raw keywords: usage is 0 by definition; the label is the latest spelling.
  keyword: `SELECT 'keyword' AS kind, 'keyword' AS subject, b.subject_key AS key, NULL AS id,
                   (SELECT x.label FROM trace_days x
                     WHERE x.subject = 'keyword' AND x.subject_key = b.subject_key
                     ORDER BY x.last_at DESC LIMIT 1) AS label,
                   '' AS vocabulary, 0 AS usage,
                   SUM(b.reads * ${decay}) AS reads,
                   SUM(b.hits) AS hits,
                   MAX(b.last_at) AS last
              FROM trace_days b
             WHERE b.subject = 'keyword' AND ${within}
             GROUP BY b.subject_key`,
});

/**
 * The cloud, ranked: `n = usage + reads`, `weight = ln(1+n)/ln(1+max_n)` with
 * ONE `max_n` across whatever `by` unioned, sorted `weight DESC, last DESC,
 * label ASC`. `include_empty` keeps the `n = 0` rows (11 px, digger's law).
 */
export function cloudSql(by: CloudBy, window: CloudWindow): string {
  const decay = window === "all" ? CLOUD_DECAY.flat : CLOUD_DECAY.decayed;
  const within = window === "all" ? CLOUD_WITHIN.all : CLOUD_WITHIN.bounded;
  const arms = cloudArms(decay, within);
  const chosen = by === "all" ? [arms.term, arms.category, arms.keyword] : [arms[by]];
  return `WITH RECURSIVE ${TERM_TREE},
          items AS (${chosen.join("\n UNION ALL \n")}),
          scored AS (SELECT *, usage + reads AS n FROM items),
          ranked AS (SELECT *, MAX(n) OVER () AS max_n FROM scored)
          SELECT kind, subject, key, id, label, vocabulary, usage, reads, hits, n, max_n, last,
                 CASE WHEN n <= 0 OR max_n <= 0 THEN 0.0 ELSE ln(1 + n) / ln(1 + max_n) END AS weight
            FROM ranked
           WHERE ?4 = 1 OR n > 0
           ORDER BY weight DESC, last DESC, label ASC
           LIMIT ?5`;
}

// ── one subject's trace (PRD §3.3 `/api/trace`) ─────────────────────────────
//
// args everywhere: ?1 subject, ?2 subject_key, ?3 cutoff ('' = all time; a day
// for trace_days, an ISO instant for traces). `days[]` and the totals come
// from trace_days so they survive the janitor; the per-row facts (kind,
// method, principal) can only come from the raw rows that still exist.
export const TRACE_OF = {
  days: `SELECT day, reads, hits FROM trace_days
          WHERE subject = ?1 AND subject_key = ?2 AND (?3 = '' OR day >= ?3)
          ORDER BY day`,
  totals: `SELECT COALESCE(SUM(reads), 0) AS count, MIN(day) AS first, MAX(last_at) AS last
             FROM trace_days
            WHERE subject = ?1 AND subject_key = ?2 AND (?3 = '' OR day >= ?3)`,
  latestLabel: `SELECT label FROM trace_days
                 WHERE subject = 'keyword' AND subject_key = ?1
                 ORDER BY last_at DESC LIMIT 1`,
  byKind: `SELECT kind, COUNT(*) AS n FROM traces
            WHERE subject = ?1 AND subject_key = ?2 AND (?3 = '' OR at >= ?3)
            GROUP BY kind ORDER BY n DESC, kind`,
  byMethod: `SELECT method, COUNT(*) AS n FROM traces
              WHERE subject = ?1 AND subject_key = ?2 AND (?3 = '' OR at >= ?3)
              GROUP BY method ORDER BY n DESC, method`,
  principals: `SELECT method, principal, ha_user, COUNT(*) AS n FROM traces
                WHERE subject = ?1 AND subject_key = ?2 AND (?3 = '' OR at >= ?3)
                GROUP BY method, principal, ha_user ORDER BY n DESC, method, principal, ha_user`,
} as const;

/** The raw rows of one subject, newest first; `own` narrows to one `ha_user` (?4). args: …, ?5 limit */
export function traceRowsSql(own: boolean): string {
  return `SELECT * FROM traces
           WHERE subject = ?1 AND subject_key = ?2 AND (?3 = '' OR at >= ?3)
             ${own ? "AND ha_user = ?4" : ""}
           ORDER BY at DESC, rowid DESC
           LIMIT ?5`;
}

// ── one category (PRD §3.3 `/api/categories/:id`) ────────────────────────────

/** One term rooted at ?1 and everything filed under it. */
const SUBTREE = `tree(id, depth) AS (
    SELECT ?1, 0
    UNION ALL
    SELECT c.id, tree.depth + 1 FROM terms c JOIN tree ON c.parent_id = tree.id WHERE tree.depth < 32
  )`;

export const CATEGORY = {
  byId: `SELECT t.*, v.name AS vocabulary, v.kind AS vocabulary_kind FROM terms t
          JOIN vocabularies v ON v.id = t.vocabulary_id
         WHERE t.id = ?`,
  byVocabularyAndName: `SELECT t.*, v.name AS vocabulary, v.kind AS vocabulary_kind FROM terms t
                         JOIN vocabularies v ON v.id = t.vocabulary_id
                        WHERE v.name = ? AND t.name = ?`,
  /** Ancestors, root first. args: termId */
  path: `WITH RECURSIVE up(id, depth) AS (
           SELECT parent_id, 0 FROM terms WHERE id = ?1
           UNION ALL
           SELECT t.parent_id, up.depth + 1 FROM terms t JOIN up ON t.id = up.id
           WHERE t.parent_id IS NOT NULL AND up.depth < 32
         )
         SELECT t.id, t.name FROM up JOIN terms t ON t.id = up.id ORDER BY up.depth DESC`,
  /** Direct children with their own usage and all-time rolled-up reads. args: termId */
  children: `WITH RECURSIVE tree(root, id, depth) AS (
               SELECT c.id, c.id, 0 FROM terms c WHERE c.parent_id = ?1
               UNION ALL
               SELECT tree.root, g.id, tree.depth + 1 FROM terms g JOIN tree ON g.parent_id = tree.id
               WHERE tree.depth < 32
             )
             SELECT c.id, c.name, c.weight,
                    (SELECT COUNT(DISTINCT nt.node_id) FROM node_terms nt WHERE nt.term_id = c.id) AS usage,
                    COALESCE((SELECT SUM(b.reads) FROM trace_days b
                               WHERE b.subject = 'term' AND b.subject_key IN (SELECT id FROM tree WHERE root = c.id)), 0) AS reads
               FROM terms c
              WHERE c.parent_id = ?1
              ORDER BY c.weight, c.name`,
  // args: termId, limit, offset
  nodes: `SELECT n.* FROM nodes n
           JOIN node_terms nt ON nt.node_id = n.id
          WHERE nt.term_id = ?
          ORDER BY n.created_at DESC, n.rowid DESC
          LIMIT ? OFFSET ?`,
  usage: `SELECT COUNT(DISTINCT node_id) AS c FROM node_terms WHERE term_id = ?`,
  /** Reads over the subtree plus the keyword alias. args: ?1 termId, ?2 yesterday, ?3 a week ago, ?4 keyword_norm(name) */
  reads: `WITH RECURSIVE ${SUBTREE}
          SELECT COALESCE(SUM(CASE WHEN b.day >= ?2 THEN b.reads ELSE 0 END), 0) AS reads_24h,
                 COALESCE(SUM(CASE WHEN b.day >= ?3 THEN b.reads ELSE 0 END), 0) AS reads_7d,
                 COALESCE(SUM(b.reads), 0) AS reads_all,
                 MAX(b.last_at) AS last_read
            FROM trace_days b
           WHERE (b.subject = 'term' AND b.subject_key IN (SELECT id FROM tree))
              OR (b.subject = 'keyword' AND b.subject_key = ?4)`,
} as const;

// ── every category (PRD §3.3 `GET /api/categories`, 1b-4) ───────────────────

/**
 * The root terms of every controlled vocabulary, each with `usage` (distinct
 * nodes filed directly under it) and all-time `reads` rolled up from its
 * whole subtree plus the keyword alias — the cloud's `category` arm with the
 * `all` window and no decay, so this menu and `/api/cloud?by=category`
 * cannot disagree about a number. Weight order, then name: the vocabulary
 * rendered in weight order IS the menu (0001_init.sql on `weight`).
 * args: none
 */
export const CATEGORIES = {
  vocabularies: `SELECT id, name, label, description, kind, created_at
                   FROM vocabularies WHERE kind = 'categories' ORDER BY name`,
  roots: `WITH RECURSIVE ${TERM_TREE}
          SELECT t.id, t.vocabulary_id, t.name, t.description, t.weight,
                 ${USAGE_OF_TERM} AS usage,
                 COALESCE(SUM(b.reads), 0) AS reads,
                 MAX(b.last_at) AS last
            FROM terms t
            JOIN vocabularies v ON v.id = t.vocabulary_id
            LEFT JOIN trace_days b
              ON ((b.subject = 'term' AND b.subject_key IN (SELECT id FROM tree WHERE root = t.id))
               OR (b.subject = 'keyword' AND b.subject_key = lower(trim(t.name))))
           WHERE v.kind = 'categories' AND t.parent_id IS NULL
           GROUP BY t.id
           ORDER BY v.name, t.weight, t.name`,
} as const;

// ── the dig (PRD §3.6) ───────────────────────────────────────────────────────
//
// Nine sources, each one statement, every caller value bound. The two LIKE
// arms escape `%`, `_` and `\` in the needle before binding (dig.ts) — the
// only place in the app a caller string reaches a LIKE pattern. `terms LIKE`
// and `mcp_calls LIKE` are the unindexed scans the < 200 ms budget watches;
// the calls arm is bounded by `called_at >= cutoff`, never by the table.

export const DIG = {
  /** Exact term name, any vocabulary — the same `lower(trim())` alias the cloud
   *  uses, so a search for "mcp" and a term named "MCP" agree here too. args: norm */
  termsExact: `SELECT t.*, v.name AS vocabulary, v.kind AS vocabulary_kind FROM terms t
                JOIN vocabularies v ON v.id = t.vocabulary_id
               WHERE lower(trim(t.name)) = ?
               ORDER BY v.name, t.weight, t.name`,
  /** Substring hits, minus the exact ones. args: escapedNorm, norm, limit */
  termsLike: `SELECT t.*, v.name AS vocabulary, v.kind AS vocabulary_kind FROM terms t
               JOIN vocabularies v ON v.id = t.vocabulary_id
              WHERE lower(t.name) LIKE '%' || ? || '%' ESCAPE '\\'
                AND lower(trim(t.name)) <> ?
              ORDER BY length(t.name), v.name, t.name
              LIMIT ?`,
  /** Ancestors of a term, root first (the category's `path[]`). args: termId */
  path: `WITH RECURSIVE up(id, depth) AS (
           SELECT parent_id, 0 FROM terms WHERE id = ?1
           UNION ALL
           SELECT t.parent_id, up.depth + 1 FROM terms t JOIN up ON t.id = up.id
           WHERE t.parent_id IS NOT NULL AND up.depth < 32
         )
         SELECT t.id, t.name FROM up JOIN terms t ON t.id = up.id ORDER BY up.depth DESC`,
  /** Prior digs of the same keyword, newest first. args: norm, limit */
  prior: `SELECT dig_seq, at, friction, confidence, counts, top FROM digs
           WHERE keyword_norm = ?
           ORDER BY at DESC, dig_seq DESC
           LIMIT ?`,
  /** Tool calls whose input mentions the keyword, inside the window. args: escapedQ, cutoffIso, limit */
  calls: `SELECT id, tool, called_at, client, input, method, principal FROM mcp_calls
           WHERE input LIKE '%' || ? || '%' ESCAPE '\\'
             AND called_at >= ?
           ORDER BY called_at DESC, rowid DESC
           LIMIT ?`,
  /** An ingress caller's own reads of the keyword (PRD §3.10 `own`). args: norm, haUser, cutoffIso|'' */
  ownTraces: `SELECT COUNT(*) AS n FROM traces
               WHERE subject = 'keyword' AND subject_key = ?1 AND ha_user = ?2 AND (?3 = '' OR at >= ?3)`,
  /** One dig row. args: at, keyword, norm, method, principal, haUser, friction, confidence, countsJson, topJson, tookMs */
  insert: `INSERT INTO digs (at, keyword, keyword_norm, method, principal, ha_user, friction, confidence, counts, top, took_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  /** The budget (PRD §3.3): digs by one `method:principal` since a cutoff. args: method, principal, cutoffIso */
  budgetCount: `SELECT COUNT(*) AS c FROM digs WHERE method = ? AND principal = ? AND at >= ?`,
  /** The Nth newest dig inside the window — when it leaves, one slot frees. args: method, principal, cutoffIso, offset */
  budgetOldest: `SELECT at FROM digs WHERE method = ? AND principal = ? AND at >= ?
                  ORDER BY at DESC, dig_seq DESC LIMIT 1 OFFSET ?`,
} as const;

/** Nodes tagged with any of these terms — the graph reach. args: …termIds, limit */
export function digGraphSql(termCount: number): string {
  return `SELECT DISTINCT n.* FROM nodes n
          JOIN node_terms nt ON nt.node_id = n.id
          WHERE nt.term_id IN (${placeholders(termCount)})
          ORDER BY n.created_at DESC, n.rowid DESC
          LIMIT ?`;
}

/** Terms that co-occur on nodes with the hit terms, most shared nodes first. args: …termIds, …termIds, limit */
export function digRelatedSql(termCount: number): string {
  return `SELECT b.term_id AS id, t.name AS name, v.name AS vocabulary, COUNT(*) AS co
            FROM node_terms a
            JOIN node_terms b ON a.node_id = b.node_id AND a.term_id <> b.term_id
            JOIN terms t ON t.id = b.term_id
            JOIN vocabularies v ON v.id = t.vocabulary_id
           WHERE a.term_id IN (${placeholders(termCount)})
             AND b.term_id NOT IN (${placeholders(termCount)})
           GROUP BY b.term_id
           ORDER BY co DESC, t.name
           LIMIT ?`;
}

/** Prior digs for `/api/digs`, newest first; `q` narrows to one keyword. args: norm, norm, limit */
export const DIGS_LIST = `SELECT dig_seq, at, keyword, keyword_norm, method, principal, ha_user, friction, confidence, counts, top, took_ms
                            FROM digs
                           WHERE ?1 = '' OR keyword_norm = ?2
                           ORDER BY at DESC, dig_seq DESC
                           LIMIT ?3`;

// ── the janitor (PRD §3.8) ───────────────────────────────────────────────────
//
// Each policy is one statement. The caps are applied as "delete the oldest N"
// with N computed by the caller from a COUNT first — never as a LIMIT built
// from a subtraction in SQL, where a negative result means "no limit" and
// would empty the table on the day it was under the cap.
export const JANITOR = {
  traces: {
    olderThan: `DELETE FROM traces WHERE at < ?`,
    count: `SELECT COUNT(*) AS c FROM traces`,
    oldest: `DELETE FROM traces WHERE rowid IN (SELECT rowid FROM traces ORDER BY at ASC, rowid ASC LIMIT ?)`,
  },
  digs: {
    count: `SELECT COUNT(*) AS c FROM digs`,
    oldest: `DELETE FROM digs WHERE dig_seq IN (SELECT dig_seq FROM digs ORDER BY at ASC, dig_seq ASC LIMIT ?)`,
  },
  calls: {
    olderThan: `DELETE FROM mcp_calls WHERE called_at < ?`,
    count: `SELECT COUNT(*) AS c FROM mcp_calls`,
    oldest: `DELETE FROM mcp_calls WHERE rowid IN (SELECT rowid FROM mcp_calls ORDER BY called_at ASC, rowid ASC LIMIT ?)`,
  },
  connections: {
    // claude.ai rows are kept whatever their age, so claudeAiState() still
    // answers "idle" rather than "none" for a connector that went quiet.
    idle: `DELETE FROM connections WHERE last_seen < ? AND label NOT LIKE 'claude.ai%'`,
    count: `SELECT COUNT(*) AS c FROM connections`,
    oldest: `DELETE FROM connections WHERE id IN (
               SELECT id FROM connections WHERE label NOT LIKE 'claude.ai%' ORDER BY last_seen ASC LIMIT ?)`,
  },
  oauthClients: {
    /** Registered, never authorised, older than a day: no token, no code in
     *  flight, never seen at the gate. args: cutoffIso */
    neverAuthorized: `DELETE FROM oauth_clients
                       WHERE created_at < ?
                         AND client_id NOT IN (SELECT client_id FROM oauth_tokens)
                         AND client_id NOT IN (SELECT client_id FROM oauth_codes)
                         AND ('oauth:' || client_id) NOT IN (SELECT id FROM connections)`,
  },
  authAttempts: {
    // args: epoch seconds
    olderThan: `DELETE FROM auth_attempts WHERE last_at < ?`,
  },
  checkpoint: `PRAGMA wal_checkpoint(PASSIVE)`,
} as const;

/** The raw log page, newest first — the `listCallsSql` rule (PRD §3.3). */
export function listTracesSql(where: string[]): string {
  return `SELECT * FROM traces
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY at DESC, rowid DESC
          LIMIT ?`;
}

// ── composable statements ────────────────────────────────────────────────────
//
// Two queries take a variable shape: listing nodes (filters + optional taxonomy
// join) and listing calls (filters). Both are built from the fragments below —
// literals defined HERE, never caller strings — with every caller value bound.

/** The taxonomy joins a node listing may need. Keys are chosen by the caller's
 *  filter shape, never by a caller-supplied string. */
const NODE_JOINS = {
  none: "",
  byTerm: `JOIN node_terms nt ON nt.node_id = n.id`,
  byVocabulary: `JOIN node_terms nt ON nt.node_id = n.id
                 JOIN terms t ON t.id = nt.term_id
                 JOIN vocabularies v ON v.id = t.vocabulary_id`,
} as const;

/**
 * `?, ?, ?` for N bound values.
 *
 * The only place this file builds SQL from a number rather than a literal. It
 * is safe for the reason all of this is safe: the COUNT comes from the caller,
 * the VALUES are still bound, and no caller string is ever concatenated.
 */
const placeholders = (count: number): string => new Array(count).fill("?").join(", ");

export type NodeJoin = keyof typeof NODE_JOINS;

/**
 * Nodes NOTHING has tagged yet.
 *
 * Tagging is the model's job, so "what has not been classified" is a real
 * working queue rather than a curiosity — it is the list a human hands to an
 * agent, and the list that shows whether the agent is keeping up.
 */
export function listUntaggedSql(where: string[]): string {
  const conditions = [...where, "nt.node_id IS NULL"];
  return `SELECT n.* FROM nodes n
          LEFT JOIN node_terms nt ON nt.node_id = n.id
          WHERE ${conditions.join(" AND ")}
          ORDER BY n.created_at DESC, n.rowid DESC
          LIMIT ? OFFSET ?`;
}

/** `where` entries must come from the caller's own literal set below. */
export const NODE_WHERE = {
  type: `n.type = ?`,
  status: `n.status = ?`,
  termId: `nt.term_id = ?`,
  vocabularyName: `v.name = ?`,
} as const;

/**
 * Nodes carrying ANY of these terms, or ALL of them.
 *
 * "any" is a plain IN with DISTINCT. "all" cannot be — a row is only in the
 * result if it matched every term, which is a GROUP BY / HAVING count, not a
 * WHERE. Getting this wrong is the classic tag-filter bug: an AND written as a
 * WHERE returns nothing at all, because no single join row can equal two terms.
 */
export function listNodesByTermsSql(termCount: number, match: "any" | "all", where: string[]): string {
  const conditions = [...where, `nt.term_id IN (${placeholders(termCount)})`];
  if (match === "any") {
    return `SELECT DISTINCT n.* FROM nodes n
            JOIN node_terms nt ON nt.node_id = n.id
            WHERE ${conditions.join(" AND ")}
            ORDER BY n.created_at DESC, n.rowid DESC
            LIMIT ? OFFSET ?`;
  }
  return `SELECT n.* FROM nodes n
          JOIN node_terms nt ON nt.node_id = n.id
          WHERE ${conditions.join(" AND ")}
          GROUP BY n.id
          HAVING COUNT(DISTINCT nt.term_id) = ?
          ORDER BY n.created_at DESC, n.rowid DESC
          LIMIT ? OFFSET ?`;
}

/** Resolve "vocabulary:term" pairs to ids in one round trip. */
export function termIdsByNameSql(count: number): string {
  return `SELECT t.id, t.name, v.name AS vocabulary FROM terms t
          JOIN vocabularies v ON v.id = t.vocabulary_id
          WHERE (v.name || ':' || t.name) IN (${placeholders(count)})`;
}

/**
 * Terms by id, with the vocabulary that decides whether a read of one is a
 * `term` (free tags) or a `category` (controlled) trace — PRD §3.1.
 */
export function termsByIdsSql(count: number): string {
  return `SELECT t.id, t.name, v.name AS vocabulary, v.kind AS vocabulary_kind FROM terms t
          JOIN vocabularies v ON v.id = t.vocabulary_id
          WHERE t.id IN (${placeholders(count)})`;
}

export function listNodesSql(join: NodeJoin, where: string[]): string {
  // rowid DESC is the tiebreaker, and it is load-bearing: created_at has
  // millisecond resolution, so a bulk import (or a test) writing several rows
  // inside one millisecond leaves the order undefined without it. Insert order
  // is the only thing that can break that tie honestly.
  return `SELECT DISTINCT n.* FROM nodes n ${NODE_JOINS[join]}
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY n.created_at DESC, n.rowid DESC
          LIMIT ? OFFSET ?`;
}

export const CALL_WHERE = {
  tool: `tool = ?`,
  outcome: `outcome = ?`,
} as const;

export function listCallsSql(where: string[]): string {
  // Same tiebreaker, same reason — a burst of tool calls shares a millisecond
  // routinely, and a log that reorders itself between reads is not a log.
  return `SELECT * FROM mcp_calls
          ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
          ORDER BY called_at DESC, rowid DESC
          LIMIT ?`;
}

/**
 * The connections ledger — a projection of the request stream, not a log.
 *
 * The UPSERT is the whole design: counters ADD, last_* values REPLACE, and
 * first_seen is kept by simply not being in the update list. One statement per
 * request, and the row is the caller rather than the call.
 */
export const CONNECTIONS = {
  // args: id, method, principal, label, userAgent, remoteIp,
  //       firstSeen, lastSeen, requests, toolCalls, lastTool
  upsert: `INSERT INTO connections
             (id, method, principal, label, user_agent, remote_ip,
              first_seen, last_seen, requests, tool_calls, last_tool)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             label      = excluded.label,
             user_agent = excluded.user_agent,
             remote_ip  = excluded.remote_ip,
             last_seen  = excluded.last_seen,
             requests   = requests + excluded.requests,
             tool_calls = tool_calls + excluded.tool_calls,
             last_tool  = COALESCE(excluded.last_tool, last_tool)`,

  // The empty-string cutoff means "everything": passing it twice lets one
  // statement serve both the windowed and the unwindowed read, rather than
  // building SQL by concatenation.
  // args: cutoff, cutoff
  list: `SELECT * FROM connections
          WHERE ?1 = '' OR last_seen >= ?2
          ORDER BY last_seen DESC`,
} as const;
