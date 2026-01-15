import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import Home from "./pages/Home.jsx";
import CockpitWeek from "./pages/CockpitWeek.jsx";
import TokensUsage from "./pages/TokensUsage.jsx";

function AppHeader() {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 12,
        padding: "12px 16px",
        borderBottom: "1px solid #e5e7eb"
      }}
    >
      <Link to="/" style={{ textDecoration: "none" }}>
        Accueil
      </Link>
      <Link to="/weeks" style={{ textDecoration: "none" }}>
        Menus
      </Link>

      <div style={{ marginLeft: "auto" }}>
        <Link to="/tokens" style={{ textDecoration: "none" }} aria-label="Tokens">
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 28,
              height: 28,
              border: "1px solid #9ca3af",
              borderRadius: "50%",
              fontSize: 14,
              color: "#374151"
            }}
          >
            T
          </span>
        </Link>
      </div>
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppHeader />
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/weeks" element={<CockpitWeek />} />
        <Route path="/tokens" element={<TokensUsage />} />
      </Routes>
    </BrowserRouter>
  );
}
