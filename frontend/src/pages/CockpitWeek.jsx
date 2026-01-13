import { useEffect, useMemo, useState } from "react";
import axios from "axios";
import { Link } from "react-router-dom";

// --- Slot labels (FR, lisibles) ---
const SLOT_LABELS_FR = {
  mon_lunch: "Lundi - dejeuner",
  mon_dinner: "Lundi - diner",
  tue_lunch: "Mardi - dejeuner",
  tue_dinner: "Mardi - diner",
  wed_lunch: "Mercredi - dejeuner",
  wed_dinner: "Mercredi - diner",
  thu_lunch: "Jeudi - dejeuner",
  thu_dinner: "Jeudi - diner",
  fri_lunch: "Vendredi - dejeuner",
  fri_dinner: "Vendredi - diner",
  sat_lunch: "Samedi - dejeuner",
  sat_dinner: "Samedi - diner",
  sun_lunch: "Dimanche - dejeuner",
  sun_dinner: "Dimanche - diner"
};

function getSlotLabel(slotKey) {
  return SLOT_LABELS_FR[slotKey] || slotKey;
}


const TAB = {
  RECIPE: "RECIPE",
  CHAT: "CHAT",
  CONSTRAINTS: "CONSTRAINTS"
};

function nowWeekIdHint() {
  // Simple aide: pas critique. L'utilisateur saisit week_id.
  return "";
}

export default function CockpitWeek() {
  // weeks list + selected week
  const [weekIds, setWeekIds] = useState([]);
  const [week, setWeek] = useState(null);
  const [loadingWeek, setLoadingWeek] = useState(true);
  const [recipeTitles, setRecipeTitles] = useState({});


  // selection slot + recipe
  const [selectedSlot, setSelectedSlot] = useState(null);
  const [selectedRecipe, setSelectedRecipe] = useState(null);

  // right panel tabs
  const [activeTab, setActiveTab] = useState(TAB.RECIPE);

  // constraints
  const [constraints, setConstraints] = useState(null);
  const [loadingConstraints, setLoadingConstraints] = useState(false);

  // chat
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);

  // prepare week form
  const [prepWeekId, setPrepWeekId] = useState(nowWeekIdHint());
  const [prepStart, setPrepStart] = useState("");
  const [prepEnd, setPrepEnd] = useState("");
  const [prepLoading, setPrepLoading] = useState(false);
  const [prepMsg, setPrepMsg] = useState("");

  const slotsEntries = useMemo(() => {
    if (!week?.slots) return [];
    return Object.entries(week.slots);
  }, [week]);

  // ---------- Loaders ----------
  async function loadWeeksList() {
    const { data } = await axios.get("/api/weeks/list");
    setWeekIds(data.week_ids || []);
    return data.week_ids || [];
  }

  async function loadWeekById(weekId) {
    setLoadingWeek(true);
    const { data } = await axios.get(`/api/weeks/${encodeURIComponent(weekId)}`);
    setWeek(data);
    setLoadingWeek(false);
    return data;
  }

  async function loadCurrentWeek() {
    setLoadingWeek(true);
    const { data } = await axios.get("/api/weeks/current");
    setWeek(data);
    setLoadingWeek(false);
    return data;
  }

  async function loadRecipe(recipeId) {
    if (!recipeId) return;
    const { data } = await axios.get(`/api/recipe-files/${encodeURIComponent(recipeId)}`);
    setSelectedRecipe(data);
  }

  async function updateRecipeStatus(recipeId, status) {
    await axios.patch(`/api/recipe-files/${encodeURIComponent(recipeId)}/status`, { status });
    await loadRecipe(recipeId);
  }

  async function loadChat(weekId) {
    const { data } = await axios.get(`/api/chat/current?week_id=${encodeURIComponent(weekId)}`);
    setChatMessages(data.messages || []);
  }

  async function sendChat() {
    if (!chatInput.trim() || !week?.week_id) return;

    setChatLoading(true);
    try {
      const payload = {
        week_id: week.week_id,
        context: selectedSlot
          ? { slot: selectedSlot, recipe_id: week.slots[selectedSlot]?.recipe_id || null }
          : { slot: null, recipe_id: null },
        message: chatInput
      };

      const { data } = await axios.post("/api/chat/current", payload);
      setChatMessages(data.messages || []);
      setChatInput("");
    } finally {
      setChatLoading(false);
    }
  }

  async function loadConstraints(weekId) {
    if (!weekId) return;
    setLoadingConstraints(true);
    try {
      const { data } = await axios.get(`/api/weeks/${encodeURIComponent(weekId)}/constraints`);
      setConstraints(data);
    } finally {
      setLoadingConstraints(false);
    }
  }

async function ensureRecipeTitle(recipeId) {
  if (!recipeId) return;
  if (recipeTitles[recipeId]) return;

  try {
    const res = await fetch(`/api/recipes/${recipeId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    setRecipeTitles((prev) => ({ ...prev, [recipeId]: data?.title || recipeId }));
  } catch {
    setRecipeTitles((prev) => ({ ...prev, [recipeId]: recipeId }));
  }
}


  // ---------- Boot ----------
  useEffect(() => {
    async function boot() {
      try {
        await loadWeeksList();
        const w = await loadCurrentWeek();
        // init selection: first slot
        const first = w?.slots ? Object.keys(w.slots)[0] : null;
        if (first) {
          setSelectedSlot(first);
          await loadRecipe(w.slots[first]?.recipe_id);
        }
        await loadChat(w.week_id);
      } catch (e) {
        console.error(e);
      }
    }
    boot();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // reload chat when week changes
  useEffect(() => {
    if (!week?.week_id) return;
    loadChat(week.week_id);
    // clear constraints cache when week changes
    setConstraints(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week?.week_id]);

  useEffect(() => {
  if (!week?.slots) return;

  const ids = Array.from(
    new Set(Object.values(week.slots).map((x) => x?.recipe_id).filter(Boolean))
  );

  ids.forEach((rid) => void ensureRecipeTitle(rid));
  // eslint-disable-next-line react-hooks/exhaustive-deps
}, [week?.week_id]);



  // ---------- Prepare week ----------
  async function prepareWeek() {
    setPrepMsg("");
    const wid = String(prepWeekId || "").trim();
    if (!wid) {
      setPrepMsg("week_id manquant (ex: 2026-W03)");
      return;
    }

    setPrepLoading(true);
    try {
      const payload = {
        week_id: wid,
        date_start: prepStart,
        date_end: prepEnd
      };

      const { data } = await axios.post("/api/weeks/prepare", payload);
      const created = Boolean(data.created);

      await loadWeeksList();
      await loadWeekById(wid);

      setPrepMsg(created ? `Semaine ${wid} creee.` : `Semaine ${wid} existait deja (chargee).`);
    } catch (e) {
      console.error(e);
      setPrepMsg(`Erreur prepare: ${e?.response?.data?.error || e.message}`);
    } finally {
      setPrepLoading(false);
    }
  }

  // ---------- UI helpers ----------
  function onSelectSlot(slot) {
    setSelectedSlot(slot);
    const rid = week?.slots?.[slot]?.recipe_id;
    setActiveTab(TAB.RECIPE);
    loadRecipe(rid);
  }

  function onChangeWeek(e) {
    const wid = e.target.value;
    if (!wid) return;
    setSelectedSlot(null);
    setSelectedRecipe(null);
    setActiveTab(TAB.RECIPE);
    loadWeekById(wid).then((w) => {
      const first = w?.slots ? Object.keys(w.slots)[0] : null;
      if (first) {
        setSelectedSlot(first);
        loadRecipe(w.slots[first]?.recipe_id);
      }
    });
  }

  // ---------- Render ----------
  if (loadingWeek && !week) {
    return <div style={{ padding: 24 }}>Chargement…</div>;
  }

  return (
    <div style={{ display: "flex", height: "100vh" }}>
      {/* LEFT PANEL */}
      <div style={{ flex: 1, padding: 24, borderRight: "1px solid #ddd", overflow: "auto" }}>
        {/* Header */}
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 style={{ margin: 0 }}>Cockpit semaine</h2>
          <Link
            to="/tokens"
            style={{ fontSize: 13, textDecoration: "none", color: "#4338ca" }}
            title="Voir tokens & usage"
          >
            📊 Tokens & usage
          </Link>
        </div>

        {/* Week selector + prepare */}
        <div style={{ display: "flex", gap: 16, alignItems: "flex-end", marginTop: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>Semaine</div>
            <select value={week?.week_id || ""} onChange={onChangeWeek} style={{ padding: 6 }}>
              {weekIds.map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </div>

          <div style={{ paddingLeft: 12, borderLeft: "1px solid #eee" }}>
            <div style={{ fontSize: 12, color: "#555", marginBottom: 4 }}>Preparer une semaine</div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
              <input
                value={prepWeekId}
                onChange={(e) => setPrepWeekId(e.target.value)}
                placeholder="week_id (ex: 2026-W03)"
                style={{ padding: 6, width: 160 }}
              />
              <input
                value={prepStart}
                onChange={(e) => setPrepStart(e.target.value)}
                placeholder="date_start (YYYY-MM-DD)"
                style={{ padding: 6, width: 170 }}
              />
              <input
                value={prepEnd}
                onChange={(e) => setPrepEnd(e.target.value)}
                placeholder="date_end (YYYY-MM-DD)"
                style={{ padding: 6, width: 170 }}
              />
              <button onClick={prepareWeek} disabled={prepLoading} style={{ padding: "6px 10px" }}>
                {prepLoading ? "Preparation..." : "Preparer"}
              </button>
            </div>
            {prepMsg && <div style={{ marginTop: 6, fontSize: 12, color: "#444" }}>{prepMsg}</div>}
          </div>
        </div>

        {/* Week recap */}
        <div style={{ marginTop: 16, fontSize: 13, color: "#444" }}>
          <div>
            <strong>{week?.week_id}</strong>{" "}
            {week?.date_start ? `(${week.date_start} -> ${week.date_end})` : ""}
          </div>
        </div>

        {/* Table slots */}
        <table style={{ width: "100%", borderCollapse: "collapse", marginTop: 12 }}>
          <thead>
            <tr>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", paddingBottom: 6 }}>
                Slot
              </th>
              <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", paddingBottom: 6 }}>
                Recette
              </th>
            </tr>
          </thead>
          <tbody>
            {slotsEntries.map(([slot, s]) => (
              <tr
                key={slot}
                style={{
                  cursor: "pointer",
                  background: selectedSlot === slot ? "#eef2ff" : "transparent"
                }}
                onClick={() => onSelectSlot(slot)}
              >
                <td style={{ padding: "6px 4px" }}>{getSlotLabel(slot)}</td>
                <td style={{ padding: "6px 4px" }}>
                {recipeTitles[s.recipe_id] || s.recipe_id}
                </td>

              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* RIGHT PANEL */}
      <div style={{ width: 520, padding: 16, display: "flex", flexDirection: "column" }}>
        {/* Tabs */}
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <button
            onClick={() => setActiveTab(TAB.RECIPE)}
            style={{ padding: "6px 10px", background: activeTab === TAB.RECIPE ? "#eef2ff" : "" }}
          >
            Recette
          </button>
          <button
            onClick={() => setActiveTab(TAB.CHAT)}
            style={{ padding: "6px 10px", background: activeTab === TAB.CHAT ? "#eef2ff" : "" }}
          >
            Chat
          </button>
          <button
            onClick={async () => {
              setActiveTab(TAB.CONSTRAINTS);
              if (!constraints && week?.week_id) await loadConstraints(week.week_id);
            }}
            style={{
              padding: "6px 10px",
              background: activeTab === TAB.CONSTRAINTS ? "#eef2ff" : ""
            }}
          >
            Contraintes
          </button>
        </div>

        {/* Tab content */}
        {activeTab === TAB.RECIPE && (
          <div style={{ overflow: "auto", border: "1px solid #ddd", padding: 12, flex: 1 }}>
            {!selectedRecipe ? (
              <div style={{ color: "#666" }}>Selectionne un slot pour charger la recette.</div>
            ) : (
              <>
                <h3 style={{ marginTop: 0 }}>{selectedRecipe.title}</h3>

                <div style={{ marginBottom: 8 }}>
                  <strong>Statut :</strong> {selectedRecipe.status}
                </div>

                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {["DRAFT", "VALIDEE", "A_MODIFIER", "REJETEE"].map((st) => (
                    <button
                      key={st}
                      onClick={() => updateRecipeStatus(selectedRecipe.recipe_id, st)}
                      style={{ padding: "6px 10px" }}
                    >
                      {st}
                    </button>
                  ))}
                </div>

                <pre
                  style={{
                    background: "#f9fafb",
                    padding: 12,
                    marginTop: 12,
                    fontSize: 12,
                    overflow: "auto"
                  }}
                >
                  {JSON.stringify(selectedRecipe, null, 2)}
                </pre>
              </>
            )}
          </div>
        )}

        {activeTab === TAB.CHAT && (
          <div style={{ display: "flex", flexDirection: "column", flex: 1 }}>
            <div style={{ fontSize: 12, color: "#555", marginBottom: 6 }}>
              Contexte actif:{" "}
              {selectedSlot
                ? `slot=${selectedSlot}, recipe_id=${week?.slots?.[selectedSlot]?.recipe_id || ""}`
                : "aucun"}
            </div>

            <div style={{ flex: 1, overflow: "auto", border: "1px solid #ddd", padding: 10 }}>
              {chatMessages.map((m, idx) => (
                <div key={idx} style={{ marginBottom: 8, fontSize: 13 }}>
                  <strong>{m.role}:</strong> {m.content}
                </div>
              ))}
            </div>

            <textarea
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              rows={3}
              placeholder="Message…"
              style={{ marginTop: 8 }}
            />

            <button
              onClick={sendChat}
              disabled={chatLoading}
              style={{ marginTop: 6, padding: "8px 10px" }}
            >
              {chatLoading ? "Envoi…" : "Envoyer"}
            </button>
          </div>
        )}

        {activeTab === TAB.CONSTRAINTS && (
          <div style={{ overflow: "auto", border: "1px solid #ddd", padding: 12, flex: 1 }}>
            {loadingConstraints ? (
              <div>Chargement contraintes…</div>
            ) : !constraints ? (
              <div style={{ color: "#666" }}>
                Clique sur "Contraintes" pour charger les contraintes de la semaine.
              </div>
            ) : (
              <>
                <h3 style={{ marginTop: 0 }}>Contraintes - {constraints.week_id}</h3>
                <pre style={{ background: "#f9fafb", padding: 12, fontSize: 12 }}>
                  {JSON.stringify(constraints, null, 2)}
                </pre>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
