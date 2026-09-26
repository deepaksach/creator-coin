// ════════════════════════════════════════════════════════════════
// auth.js
// ────────────────────────────────────────────────────────────────
// Everything about "how do we know who this user is" lives here.
// server.js imports functions from this file but never needs to
// know HOW hashing or sessions work internally.
//
// THE BIG PICTURE STORY (a concert wristband):
//   1. hashPassword    -- the box office blends your password into
//                         mush before writing it down.
//   2. verifyPassword  -- checking a login by re-blending and
//                         comparing, never by "un-blending."
//   3. createSession   -- once verified, you get a wristband
//                         (a random token) instead of showing ID
//                         on every action.
//   4. getUserFromToken -- the guard at the door reads your
//                         wristband and looks up whose it is.
//   5. deleteSession   -- logging out cuts the wristband off.
//
// POSTGRES vs SQLite CHANGES:
//   • All db calls are now async (pool.query returns a Promise).
//   • Every function is now declared `async` and uses `await`.
//   • Query results come back as `result.rows[0]` (an object) or
//     `result.rows` (an array), instead of `.get()` / `.all()`.
//   • Parameterised queries use $1, $2, … placeholders instead of ?
//     (this is PostgreSQL's placeholder syntax).
// ════════════════════════════════════════════════════════════════

const crypto = require("node:crypto");

// The shared pg Pool exported by db.js.
// pool.query(sql, [params]) returns a Promise that resolves to a
// result object: { rows: [...], rowCount: N, ... }.
const pool = require("./db");

// ── PASSWORD HASHING ─────────────────────────────────────────────
// hashPassword is still synchronous internally (crypto.scryptSync
// is CPU-bound, not I/O-bound), but we keep it a plain function
// that returns { hash, salt } synchronously — no db call needed.
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { hash, salt };
}

// verifyPassword is also still synchronous — same reason.
function verifyPassword(password, salt, expectedHash) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return hash === expectedHash;
}

// ── SESSION MANAGEMENT ────────────────────────────────────────────

// createSession inserts a new row into the sessions table and
// returns the token. Now async because pool.query is async.
//
// $1, $2 are PostgreSQL's positional placeholders — equivalent to
// SQLite's ?, but numbered. The values array [token, userId] maps
// to $1 and $2 in order.
async function createSession(userId) {
  const token = crypto.randomUUID();
  await pool.query(
    "INSERT INTO sessions (token, user_id) VALUES ($1, $2)",
    [token, userId]
  );
  return token;
}

// getUserFromToken looks up the session row and then the user row.
// Returns a user object { id, email, created_at } or null.
//
// result.rows is always an array; result.rows[0] is the first row
// (or undefined if nothing matched, which the !session guard below
// handles).
async function getUserFromToken(token) {
  if (!token) return null;

  const sessionResult = await pool.query(
    "SELECT * FROM sessions WHERE token = $1",
    [token]
  );
  const session = sessionResult.rows[0];
  if (!session) return null;

  const userResult = await pool.query(
    "SELECT id, email, created_at FROM users WHERE id = $1",
    [session.user_id]
  );
  // Return the user row, or null if it somehow doesn't exist.
  return userResult.rows[0] || null;
}

// deleteSession removes the session row so the token is no longer
// valid. Now async for the same reason as createSession.
async function deleteSession(token) {
  await pool.query("DELETE FROM sessions WHERE token = $1", [token]);
}

module.exports = { hashPassword, verifyPassword, createSession, getUserFromToken, deleteSession };
