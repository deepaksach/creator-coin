// ════════════════════════════════════════════════════════════════
// db.js
// ────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS FOR, IN ONE SENTENCE:
// It creates a PostgreSQL connection pool, ensures the tables we
// need exist, and exports the pool so every other file can query
// the database without opening their own connections.
//
// WHY A POOL (not a single connection)?
// PostgreSQL is a separate process — every query goes over a real
// TCP socket. A Pool keeps several connections open and reuses them
// across requests, which is far more efficient than opening and
// closing a fresh connection per query. `pg.Pool` manages this
// automatically; we just call pool.query(sql, params) anywhere we
// need data.
//
// CONNECTION STRING:
// The DATABASE_URL environment variable is read from a .env file
// (via dotenv) when running locally, and is expected to be set as
// a real env var in any deployed environment.
// Format: postgres://user:password@host:port/dbname
// ════════════════════════════════════════════════════════════════

// Load .env file values into process.env (if the file exists).
// In production the real environment variables take precedence
// automatically — dotenv only fills in what isn't already set.
require("dotenv").config();

const { Pool } = require("pg");

// Create the shared connection pool.
// `connectionString` reads the full postgres URL from the env.
// `ssl` is set to require TLS only when DATABASE_URL contains
// "localhost" or "127.0.0.1" is NOT the host (i.e. a remote/cloud
// DB). Set DATABASE_SSL=false in .env to disable explicitly.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  // Many cloud Postgres providers (Railway, Render, Supabase, etc.)
  // require SSL. `rejectUnauthorized: false` skips certificate
  // validation, which is acceptable for a learning project.
  // In production you should supply a proper CA certificate instead.
  ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
});

// ── SCHEMA INITIALISATION ────────────────────────────────────────
// `initDb()` creates the three tables the app needs if they don't
// already exist. It's called once at the bottom of this file using
// a top-level await pattern (wrapped in an IIFE because db.js is
// CommonJS, not ESM). If the tables are already there from a
// previous run, CREATE TABLE IF NOT EXISTS is a safe no-op.
//
// PostgreSQL differences from SQLite worth noting:
//  • SERIAL       — Postgres's auto-increment integer (replaces
//                   SQLite's INTEGER PRIMARY KEY AUTOINCREMENT).
//  • TIMESTAMP DEFAULT NOW() — Postgres timestamp with current time
//                   default (replaces SQLite's DEFAULT CURRENT_TIMESTAMP).
//  • TEXT         — works the same in both; Postgres also supports
//                   VARCHAR(n) but TEXT is fine here.
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id             SERIAL PRIMARY KEY,
      email          TEXT UNIQUE NOT NULL,
      password_hash  TEXT NOT NULL,
      salt           TEXT NOT NULL,
      created_at     TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token       TEXT PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id),
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS trades (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER REFERENCES users(id),
      type        TEXT NOT NULL DEFAULT 'buy',
      amount      INTEGER NOT NULL,
      price       REAL NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    )
  `);

  // A single-row table used purely for SELECT FOR UPDATE locking.
  // The trade transaction acquires a row-level lock on this row before
  // reading supply — this forces concurrent trades to queue up and
  // execute one at a time, so each one sees the supply left by the
  // previous commit. Without this, two simultaneous trades under
  // Postgres's default READ COMMITTED isolation can both read the
  // same stale supply before either commits, producing the wrong price.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS trade_lock (
      id INTEGER PRIMARY KEY
    )
  `);
  // Ensure the single lock row exists. ON CONFLICT DO NOTHING makes
  // this a safe no-op on every subsequent startup.
  await pool.query(`
    INSERT INTO trade_lock (id) VALUES (1) ON CONFLICT DO NOTHING
  `);

  console.log("✓ Database tables ready");
}

// Run initDb immediately when this module is first required.
// Any error here (wrong credentials, unreachable host) is fatal —
// crash loudly rather than silently serving a broken app.
initDb().catch((err) => {
  console.error("✗ Failed to initialise database:", err.message);
  process.exit(1);
});

// Export the pool — auth.js and server.js call pool.query() directly.
module.exports = pool;
