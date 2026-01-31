import { BrowserRouter, Routes, Route, Link } from "react-router-dom";
import Home from "./pages/Home.jsx";
import CockpitWeek from "./pages/CockpitWeek.jsx";

function AppHeader() {
  return (
    <div className="app-header">
      <Link to="/" className="nav-link" aria-label="Accueil">
        ⌂
      </Link>
      <Link to="/weeks" className="nav-link">
        Menus
      </Link>

      <div style={{ marginLeft: "auto" }}>
        <a
          href="https://platform.openai.com/settings/organization/usage"
          target="_blank"
          rel="noreferrer"
          aria-label="OpenAI Usage"
        >
          <span className="avatar-chip">T</span>
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
