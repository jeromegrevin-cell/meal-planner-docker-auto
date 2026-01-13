import { BrowserRouter, Routes, Route } from "react-router-dom";
import CockpitWeek from "./pages/CockpitWeek.jsx";
import TokensUsage from "./pages/TokensUsage.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<CockpitWeek />} />
        <Route path="/tokens" element={<TokensUsage />} />
      </Routes>
    </BrowserRouter>
  );
}
