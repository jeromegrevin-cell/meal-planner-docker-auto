import React, { useEffect, useMemo, useState } from "react";

/* ====================
   Slots FR
==================== */
const SLOT_LABELS_FR = {
  mon_lunch: "Lundi déjeuner",
  mon_dinner: "Lundi dîner",
  tue_lunch: "Mardi déjeuner",
  tue_dinner: "Mardi dîner",
  wed_lunch: "Mercredi déjeuner",
  wed_dinner: "Mercredi dîner",
  thu_lunch: "Jeudi déjeuner",
  thu_dinner: "Jeudi dîner",
  fri_lunch: "Vendredi déjeuner",
  fri_dinner: "Vendredi dîner",
  sat_lunch: "Samedi déjeuner",
  sat_dinner: "Samedi dîner",
  sun_lunch: "Dimanche déjeuner",
  sun_dinner: "Dimanche dîner"
};

const ALL_SLOTS = Object.keys(SLOT_LABELS_FR);

function getSlotLabel(slot) {
  return SLOT_LABELS_FR[slot] || slot;
}

/* ====================
   Utils
==================== */
async function fetchJson(url, options) {
  const r = await fetch(url, options);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j?.details || j?.error || `HTTP ${r.status}`);
  return j;
}

function buildOtherProposalPrompt(slot) {
  return `Propose une AUTRE recette pour ${getSlotLabel(slot)}.
Contraintes: 3 personnes, hiver, simple, budget Lidl/Carrefour.
Réponds en 1 ligne : "Titre - idée rapide".`;
}

/* ====================
   Component
==================== */
export default function CockpitWeek() {
  const [weekIds, setWeekIds] = useState([]);
  const [selectedWeekId, setSelectedWeekId] = useState("");
  const [week, setWeek] = useState(null);

  const [selectedSlot, setSelectedSlot] = useState(null);
  const [recipe, setRecipe] = useState(null);
  const [recipeTitles, setRecipeTitles] = useState({});

  const [menuProposals, setMenuProposals] = useState({});
  const [savedProposalIds, setSavedProposalIds] = useState({});

  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatWarning, setChatWarning] = useState(null);

  const [freeTextBySlot, setFreeTextBySlot] = useState({});

  const [prepWeekId, setPrepWeekId] = useState("");
  const [prepStart, setPrepStart] = useState("");
  const [prepEnd, setPrepEnd] = useState("");

  /* ====================
     Derived
  ==================== */
  const tableRows = useMemo(() => {
    const slots = week?.slots || {};
    return ALL_SLOTS.map((slot) => [slot, slots[slot] || {}]);
  }, [week]);

  /* ====================
     Loaders
  ==================== */
  async function loadWeeksList() {
    const j = await fetchJson("/api/weeks/list");
    setWeekIds(j.week_ids || []);
  }

  async function loadWeek(id) {
    const w = await fetchJson(`/api/weeks/${id}`);
    setWeek(w);
    setSelectedWeekId(w.week_id);
    return w;
  }

  async function loadCurrentWeek() {
    const w = await fetchJson("/api/weeks/current");
    setWeek(w);
    setSelectedWeekId(w.week_id);
    return w;
  }

  async function loadRecipe(recipeId) {
    if (!recipeId) {
      setRecipe(null);
      return;
    }
    const r = await fetchJson(`/api/recipes/${recipeId}`);
    setRecipe(r);
    setRecipeTitles((p) => ({ ...p, [recipeId]: r.title || recipeId }));
  }

  async function loadChat(weekId) {
    const j = await fetchJson(`/api/chat/current?week_id=${weekId}`);
    setChatMessages(j.messages || []);
    setChatWarning(j.warning || null);
  }

  async function loadMenuProposals(weekId) {
    try {
      const j = await fetchJson(`/api/chat/proposals?week_id=${weekId}`);
      setMenuProposals(j.menu_proposals || {});
    } catch {
      setMenuProposals({});
    }
  }

  /* ====================
     Init
  ==================== */
  useEffect(() => {
    (async () => {
      await loadWeeksList();
      const w = await loadCurrentWeek();
      const first = ALL_SLOTS.find((s) => w.slots?.[s]?.recipe_id) || "mon_dinner";
      setSelectedSlot(first);
      await loadRecipe(w.slots?.[first]?.recipe_id);
      await loadChat(w.week_id);
      await loadMenuProposals(w.week_id);
    })();
  }, []);

  useEffect(() => {
    if (!week || !selectedSlot) return;
    loadRecipe(week.slots?.[selectedSlot]?.recipe_id || null);
  }, [selectedSlot]);

  /* ====================
     Actions
  ==================== */
  async function onPrepareWeek() {
    await fetchJson("/api/weeks/prepare", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        week_id: prepWeekId,
        date_start: prepStart,
        date_end: prepEnd
      })
    });
    await loadWeeksList();
    await loadWeek(prepWeekId);
    setPrepWeekId("");
    setPrepStart("");
    setPrepEnd("");
  }

  async function onSendChat() {
    if (!chatInput.trim()) return;
    await fetchJson("/api/chat/current", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        week_id: week.week_id,
        message: chatInput,
        context: { slot: selectedSlot }
      })
    });
    setChatInput("");
    await loadChat(week.week_id);
    await loadMenuProposals(week.week_id);
  }

  async function onValidateProposal(slot, p) {
    const j = await fetchJson(
      `/api/weeks/${week.week_id}/slots/${slot}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipe_id: p.recipe_id || null,
          free_text: p.title
        })
      }
    );
    setWeek(j.week);
    await loadRecipe(j.week.slots?.[slot]?.recipe_id || null);
  }

  async function onOtherProposal(slot) {
    await fetchJson("/api/chat/current", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        week_id: week.week_id,
        message: buildOtherProposalPrompt(slot),
        context: { slot }
      })
    });
    await loadMenuProposals(week.week_id);
  }

  function renderSlotLabel(slot, s) {
    if (s.recipe_id) return recipeTitles[s.recipe_id] || s.recipe_id;
    if (s.free_text) return s.free_text;
    return "";
  }

  /* ====================
     Render
  ==================== */
  return (
    <div style={{ padding: 16 }}>
      <h2>Cockpit semaine</h2>

      <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        <select value={selectedWeekId} onChange={(e) => loadWeek(e.target.value)}>
          {weekIds.map((id) => (
            <option key={id}>{id}</option>
          ))}
        </select>

        <input value={prepWeekId} onChange={(e) => setPrepWeekId(e.target.value)} placeholder="2026-W04" />
        <input value={prepStart} onChange={(e) => setPrepStart(e.target.value)} placeholder="YYYY-MM-DD" />
        <input value={prepEnd} onChange={(e) => setPrepEnd(e.target.value)} placeholder="YYYY-MM-DD" />
        <button onClick={onPrepareWeek}>Préparer</button>
      </div>

      <table style={{ width: "100%", marginTop: 16 }}>
        <thead>
          <tr>
            <th>Jour / repas</th>
            <th>Recette</th>
          </tr>
        </thead>
        <tbody>
          {tableRows.map(([slot, s]) => (
            <tr key={slot} onClick={() => setSelectedSlot(slot)}>
              <td>{getSlotLabel(slot)}</td>
              <td>
                <div>{renderSlotLabel(slot, s)}</div>

                {!s.recipe_id && (
                  <textarea
                    value={freeTextBySlot[slot] || ""}
                    onChange={(e) =>
                      setFreeTextBySlot((p) => ({ ...p, [slot]: e.target.value }))
                    }
                    rows={2}
                    style={{ width: "100%" }}
                  />
                )}

                {(menuProposals[slot] || []).map((p) => (
                  <div key={p.proposal_id} style={{ display: "flex", gap: 6 }}>
                    <span>{p.title}</span>
                    <button onClick={() => onValidateProposal(slot, p)}>Valider</button>
                    <button onClick={() => onOtherProposal(slot)}>Autre</button>
                    <button
                      disabled={savedProposalIds[p.proposal_id]}
                      onClick={() =>
                        setSavedProposalIds((x) => ({ ...x, [p.proposal_id]: true }))
                      }
                    >
                      Sauvegarder
                    </button>
                  </div>
                ))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ marginTop: 16 }}>
        <h3>Chat</h3>
        <div style={{ maxHeight: 200, overflow: "auto" }}>
          {chatMessages.map((m, i) => (
            <div key={i}>
              <b>{m.role}</b>: {m.content}
            </div>
          ))}
        </div>
        <input
          value={chatInput}
          onChange={(e) => setChatInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSendChat()}
        />
        <button onClick={onSendChat}>Envoyer</button>
      </div>
    </div>
  );
}
