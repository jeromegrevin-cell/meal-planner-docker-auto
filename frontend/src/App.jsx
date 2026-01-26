import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import Home from "./pages/Home.jsx";
import CockpitWeek from "./pages/CockpitWeek.jsx";

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
        <a
          href="https://platform.openai.com/settings/organization/usage"
          target="_blank"
          rel="noreferrer"
          style={{ textDecoration: "none" }}
          aria-label="OpenAI Usage"
        >
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
        </a>
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
      </Routes>
    </BrowserRouter>
  );
}
