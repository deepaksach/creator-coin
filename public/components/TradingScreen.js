// ── TradingScreen ─────────────────────────────────────────────────
// Shown when a user is logged in. Displays live price, holdings,
// trade log, and the Buy button.
//
// Props:
//   user        — { id, email, created_at } from the server
//   onLoggedOut — callback to tell App to clear the user and show AuthScreen
//
// Relies on globals: React, useState, useEffect (from App.js scope),
// and the Socket.IO client `io` (from /socket.io/socket.io.js).
// ─────────────────────────────────────────────────────────────────
function TradingScreen({ user, onLoggedOut }) {
  const [status, setStatus] = useState("connecting...");
  const [price, setPrice] = useState(0);
  const [supply, setSupply] = useState(0);
  const [trades, setTrades] = useState([]);
  const [holdings, setHoldings] = useState(0);
  const [justBought, setJustBought] = useState(false);

  // Fetches the logged-in user's current coin holdings from the server.
  // Called on mount and after every trade broadcast.
  function loadHoldings() {
    fetch("/my-holdings")
      .then((res) => res.json())
      .then((data) => setHoldings(data.holdings));
  }

  useEffect(() => {
    // Load initial state: price, trade history, personal holdings.
    fetch("/price")
      .then((res) => res.json())
      .then((data) => { setPrice(data.price); setSupply(data.supply); });

    fetch("/trades")
      .then((res) => res.json())
      .then((data) => setTrades(data));

    loadHoldings();

    // Open the Socket.IO WebSocket connection.
    // `io()` connects back to the same server this page was loaded from.
    const socket = io();

    socket.on("connect", () => setStatus("connected"));

    // Fired by server's io.emit("newTrade", trade) whenever anyone buys.
    // Updates every open tab simultaneously.
    socket.on("newTrade", (trade) => {
      setPrice(trade.price);
      setSupply(trade.supply);
      // Updater-function form prevents stale closure bug —
      // this callback was created once at mount, so a plain
      // `trades` reference here would be the initial empty array.
      setTrades((prev) => [trade, ...prev]);
      loadHoldings();
      setJustBought(true);
      setTimeout(() => setJustBought(false), 500);
    });

    // Cleanup: disconnect the socket when the user logs out
    // and TradingScreen unmounts.
    return () => socket.disconnect();
  }, []);

  async function buy() {
    const res = await fetch("/trades", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ amount: 1 }),
    });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error || "Trade failed, please retry.");
    }
    // UI update is handled by the "newTrade" socket event,
    // not by reading this response directly.
  }

  async function logout() {
    await fetch("/logout", { method: "POST" });
    onLoggedOut();
  }

  return (
    <div className="card">
      <div className="account-bar">
        <span>{user.email}</span>
        <span className="logout-link" onClick={logout}>log out</span>
      </div>

      <div className="top-row">
        <span className="coin-name">CREATOR</span>
        <span className={"status" + (status !== "connected" ? " connecting" : "")}>
          {status === "connected" ? "live" : status}
        </span>
      </div>

      <div id="price" className={justBought ? "price-up" : ""}>
        ${Number(price).toFixed(4)}
      </div>
      <div className="supply">{supply} coins in circulation</div>

      <div className="holdings">
        <span>Your holdings</span>
        <strong>{holdings} coins</strong>
      </div>

      <button onClick={buy}>Buy 1 coin</button>

      <h3>Trade log</h3>
      {trades.length === 0 && <div className="empty">No trades yet — click Buy</div>}
      <ul>
        {trades.map((t) => (
          <li key={t.id}>
            <span className="amount">
              #{t.id} · bought {t.amount}
              {t.email && <span className="trade-who"> · {t.email}</span>}
            </span>
            <span className="new-price">${Number(t.price).toFixed(4)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
