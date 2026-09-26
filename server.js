// ════════════════════════════════════════════════════════════════
// server.js
// ────────────────────────────────────────────────────────────────
// Entry point of the whole backend. Sets up Express, wraps it in a
// raw Node http server for Socket.IO, defines all middleware and
// routes, then starts listening on port 3000.
//
// POSTGRES vs SQLite CHANGES (compared to the original):
//   • All db calls are now async — every route handler that touches
//     the database is now `async (req, res) => { ... }` and uses
//     `await pool.query(sql, params)`.
//   • Parameterised queries use $1, $2, … instead of ?.
//   • Results come back as `result.rows[0]` (one row) or
//     `result.rows` (array), replacing .get() / .all().
//   • Transactions use explicit client checkout (pool.connect())
//     because a transaction must run on the SAME connection; the
//     pool would otherwise hand different queries to different
//     connections. BEGIN / COMMIT / ROLLBACK are sent as queries.
//   • getCurrentSupply() is now async and awaits pool.query.
//   • attachUser middleware is now async, and requireAuth was
//     refactored to still work synchronously (req.user is already
//     set by the time it runs).
//   • dotenv is loaded here too (harmless duplicate; dotenv skips
//     re-loading if already loaded by db.js).
// ════════════════════════════════════════════════════════════════

require("dotenv").config();

const express    = require("express");
const http       = require("http");
const cookieParser = require("cookie-parser");
const { Server } = require("socket.io");

// pg Pool exported by db.js (also runs initDb on first require).
const pool = require("./db");

const {
  hashPassword,
  verifyPassword,
  createSession,
  getUserFromToken,
  deleteSession,
} = require("./auth");

// ── SERVER SETUP ──────────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

app.use(express.json());
app.use(cookieParser());
app.use(express.static("public"));

// ── PRICING MATH ──────────────────────────────────────────────────
const BASE_PRICE = 1.0;
const K          = 0.01;

function priceForSupply(supply) {
  return BASE_PRICE + K * supply;
}

// Now async — pool.query returns a Promise.
// PostgreSQL uses $1 placeholders; results are in result.rows.
// COALESCE handles an empty trades table (SUM over no rows → NULL).
async function getCurrentSupply() {
  const result = await pool.query(`
    SELECT COALESCE(
      SUM(CASE WHEN type = 'buy' THEN amount ELSE -amount END),
    0) AS supply
    FROM trades
  `);
  // result.rows[0].supply is a string from pg for numeric/bigint
  // columns — Number() converts it safely.
  return Number(result.rows[0].supply);
}

// ── AUTH MIDDLEWARE ────────────────────────────────────────────────
// attachUser is now async because getUserFromToken is async.
async function attachUser(req, res, next) {
  const token = req.cookies.session_token;
  req.user = await getUserFromToken(token); // null if not logged in
  next();
}

app.use(attachUser);

// requireAuth is still synchronous — by the time it runs, attachUser
// has already resolved req.user (Express awaits the async middleware
// before moving to the next one in the chain).
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "you must be logged in" });
  }
  next();
}

// ── AUTH ROUTES ────────────────────────────────────────────────────

app.post("/signup", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: "email and password are required" });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: "password must be at least 6 characters" });
  }

  // Check for an existing account.
  const existing = await pool.query(
    "SELECT id FROM users WHERE email = $1",
    [email]
  );
  if (existing.rows[0]) {
    return res.status(409).json({ error: "an account with that email already exists" });
  }

  const { hash, salt } = hashPassword(password);

  // INSERT … RETURNING id — PostgreSQL's way of getting the
  // auto-generated primary key back in one round-trip, replacing
  // SQLite's result.lastInsertRowid.
  const insertResult = await pool.query(
    "INSERT INTO users (email, password_hash, salt) VALUES ($1, $2, $3) RETURNING id",
    [email, hash, salt]
  );
  const newUserId = insertResult.rows[0].id;

  const token = await createSession(newUserId);
  res.cookie("session_token", token, { httpOnly: true, sameSite: "strict" });
  res.json({ id: newUserId, email });
});

app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  // SELECT * so we have password_hash and salt for verification.
  const result = await pool.query(
    "SELECT * FROM users WHERE email = $1",
    [email]
  );
  const user = result.rows[0];

  if (!user || !verifyPassword(password, user.salt, user.password_hash)) {
    return res.status(401).json({ error: "invalid email or password" });
  }

  const token = await createSession(user.id);
  res.cookie("session_token", token, { httpOnly: true, sameSite: "strict" });
  res.json({ id: user.id, email: user.email });
});

app.post("/logout", async (req, res) => {
  if (req.cookies.session_token) {
    await deleteSession(req.cookies.session_token);
  }
  res.clearCookie("session_token");
  res.json({ ok: true });
});

app.get("/me", (req, res) => {
  // req.user already set by attachUser — no extra db call needed.
  res.json({ user: req.user });
});

// ── MISC ROUTES ───────────────────────────────────────────────────

app.get("/hello", (req, res) => {
  res.send("You specifically asked for /hello!");
});

app.get("/price", async (req, res) => {
  const supply = await getCurrentSupply();
  res.json({ coin: "CREATOR", supply, price: priceForSupply(supply) });
});

// ── TRADING ────────────────────────────────────────────────────────
// Transactions in pg require checking out a dedicated client from the
// pool. Unlike SQLite's db.exec("BEGIN"), pool.query() could route
// each statement to a different connection — so we must use a single
// client for the entire BEGIN→COMMIT/ROLLBACK block.
app.post("/trades", requireAuth, async (req, res) => {
  const amount = Number(req.body.amount) || 1;
  if (amount <= 0) {
    return res.status(400).json({ error: "amount must be a positive number" });
  }

  // Check out one connection from the pool for the transaction.
  const client = await pool.connect();
  let trade;

  try {
    // BEGIN IMMEDIATE is SQLite syntax; in Postgres, BEGIN (or
    // BEGIN TRANSACTION) starts a transaction. Write locking is
    // handled automatically by Postgres's MVCC — no IMMEDIATE needed.
    await client.query("BEGIN");

    // Acquire an exclusive row-level lock on the trade_lock row.
    // Any other transaction that reaches this line while we hold the
    // lock will block here until we COMMIT or ROLLBACK — this
    // serialises concurrent trades so each one reads the supply that
    // the previous trade actually committed, not a stale snapshot.
    // Without this, Postgres's default READ COMMITTED isolation allows
    // two simultaneous requests to both SELECT the same supply before
    // either inserts, producing the same (wrong) price for both.
    await client.query("SELECT id FROM trade_lock WHERE id = 1 FOR UPDATE");

    const supplyResult = await client.query(`
      SELECT COALESCE(
        SUM(CASE WHEN type = 'buy' THEN amount ELSE -amount END),
      0) AS supply
      FROM trades
    `);
    const currentSupply = Number(supplyResult.rows[0].supply);
    const newSupply     = currentSupply + amount;
    const price         = priceForSupply(newSupply);

    // RETURNING id gives us the new row's id without a second query.
    const insertResult = await client.query(
      "INSERT INTO trades (user_id, type, amount, price) VALUES ($1, 'buy', $2, $3) RETURNING id",
      [req.user.id, amount, price]
    );

    await client.query("COMMIT");

    trade = {
      id:     insertResult.rows[0].id,
      type:   "buy",
      amount,
      price,
      supply: newSupply,
      email:  req.user.email,
    };
  } catch (err) {
    await client.query("ROLLBACK");
    console.error("Trade failed:", err.message);
    return res.status(500).json({ error: "trade failed, please retry" });
  } finally {
    // ALWAYS release the client back to the pool — whether the
    // transaction succeeded or failed. Forgetting this leaks
    // connections and will eventually stall the app.
    client.release();
  }

  io.emit("newTrade", trade);
  res.json(trade);
});

app.get("/trades", async (req, res) => {
  // LEFT JOIN so trades with a NULL user_id (pre-auth rows) still
  // appear, just with a null email. ORDER BY DESC = newest first.
  const result = await pool.query(`
    SELECT trades.*, users.email
    FROM trades
    LEFT JOIN users ON users.id = trades.user_id
    ORDER BY trades.id DESC
  `);
  res.json(result.rows);
});

app.get("/my-holdings", requireAuth, async (req, res) => {
  const result = await pool.query(`
    SELECT COALESCE(
      SUM(CASE WHEN type = 'buy' THEN amount ELSE -amount END),
    0) AS holdings
    FROM trades
    WHERE user_id = $1
  `, [req.user.id]);
  res.json({ holdings: Number(result.rows[0].holdings) });
});

// ── SOCKET.IO ─────────────────────────────────────────────────────
io.on("connection", (socket) => {
  console.log("a browser connected via websocket:", socket.id);
});

// ── START ─────────────────────────────────────────────────────────
server.listen(3000, () => {
  console.log("Server is up. Waiting on http://localhost:3000");
});
