import { Link } from "react-router-dom";

export default function Home() {
  return (
    <div style={{ padding: 24 }}>
      <h2 style={{ marginTop: 0 }}>Accueil</h2>
      <p style={{ marginTop: 6, opacity: 0.8 }}>
        Acces rapide aux menus hebdomadaires et au suivi des tokens.
      </p>

      <div style={{ display: "flex", gap: 12, marginTop: 16 }}>
        <Link to="/weeks" style={{ textDecoration: "none" }}>
          <button style={{ padding: "8px 12px" }}>Menus hebdomadaires</button>
        </Link>
        <Link to="/tokens" style={{ textDecoration: "none" }}>
          <button style={{ padding: "8px 12px" }}>Tokens</button>
        </Link>
      </div>

      <div style={{ marginTop: 24, padding: 12, border: "1px solid #ddd", borderRadius: 8 }}>
        <div style={{ fontWeight: 700, marginBottom: 6 }}>
          Calendrier (a venir)
        </div>
        <div style={{ fontSize: 13, opacity: 0.8 }}>
          Cette section affichera le tableau des jours passes avec les repas
          (dejeuner / diner) et un acces direct aux recettes.
        </div>
      </div>
    </div>
  );
}
