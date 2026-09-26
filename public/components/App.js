// ── App ───────────────────────────────────────────────────────────
// Root component. Decides whether to show AuthScreen or TradingScreen
// based on session state.
//
// Also the entry point for the whole React app — ReactDOM.createRoot
// and root.render() live here, at the bottom.
//
// This file must be loaded LAST in index.html, after AuthScreen.js
// and TradingScreen.js, because it references those components.
// ─────────────────────────────────────────────────────────────────

// useState and useEffect are destructured in AuthScreen.js (the first
// component file loaded) and are available here as globals.

function App() {
  const [user, setUser] = useState(null);
  // Separate flag so we don't flash AuthScreen while /me is in-flight.
  const [checkedSession, setCheckedSession] = useState(false);

  useEffect(() => {
    // On every page load, ask the server if there's already a valid
    // session cookie — keeps the user logged in across refreshes.
    fetch("/me")
      .then((res) => res.json())
      .then((data) => {
        setUser(data.user);       // null if not logged in
        setCheckedSession(true);  // we now have a definitive answer
      });
  }, []);

  // Render nothing while waiting for /me to respond.
  if (!checkedSession) return null;

  if (!user) {
    return <AuthScreen onLoggedIn={(u) => setUser(u)} />;
  }

  return <TradingScreen user={user} onLoggedOut={() => setUser(null)} />;
}

// Mount the React app into the #root div declared in index.html.
const root = ReactDOM.createRoot(document.getElementById("root"));
root.render(<App />);
