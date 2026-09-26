// ── AuthScreen ────────────────────────────────────────────────────
// Shown when no user is logged in. Handles both login and signup.
// Receives one prop: onLoggedIn(user) — called by App once auth
// succeeds, which swaps this screen out for TradingScreen.
// ─────────────────────────────────────────────────────────────────

// useState/useEffect are destructured here (first file to load)
// so all component files that load after this can use them as
// plain names — all <script type="text/babel"> blocks share the
// same global scope in this no-build setup.
const { useState, useEffect } = React;

function AuthScreen({ onLoggedIn }) {
  const [mode, setMode] = useState("login"); // "login" or "signup"
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError("");
    setSubmitting(true);

    const res = await fetch(`/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });

    const data = await res.json();
    setSubmitting(false);

    if (!res.ok) {
      setError(data.error || "something went wrong");
      return;
    }

    onLoggedIn(data);
  }

  return (
    <div className="card">
      <div className="top-row">
        <span className="coin-name">CREATOR</span>
      </div>

      <div className="tabs">
        <div
          className={"tab" + (mode === "login" ? " active" : "")}
          onClick={() => { setMode("login"); setError(""); }}
        >
          Log in
        </div>
        <div
          className={"tab" + (mode === "signup" ? " active" : "")}
          onClick={() => { setMode("signup"); setError(""); }}
        >
          Sign up
        </div>
      </div>

      <form onSubmit={handleSubmit}>
        <input
          type="email"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        <input
          type="password"
          placeholder="Password (min 6 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
        />
        {error && <div className="auth-error">{error}</div>}
        <button type="submit" disabled={submitting}>
          {submitting ? "Please wait..." : mode === "login" ? "Log in" : "Create account"}
        </button>
      </form>
    </div>
  );
}
