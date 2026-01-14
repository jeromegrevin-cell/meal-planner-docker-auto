import React, { useEffect, useMemo, useState } from "react";

// --------------------
// Slots - FR labels + order
// --------------------
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

const ALL_SLOTS = [
  "mon_lunch","mon_dinner",
  "tue_lunch","tue_dinner",
  "wed_lunch","wed_dinner",
  "thu_lunch","thu_dinner",
  "fri_lunch","fri_dinner",
  "sat_lunch","sat_dinner",
  "sun_lunch","sun_dinner"
];

// Seuls ces slots ont un champ libre possible
const FREE_TEXT_ALLOWED_SLOTS = new Set([
  "mon_lunch",
  "tue_lunch",
  "thu_lunch",
  "fri_lunch"
]);

function getSlotLabel(slotKey) {
  return SLOT_LABELS_FR[slotKey] || slotKey;
}

// --------------------
// Helpers
// --------------------
async function fetchJson(url, options) {
  const r = await fetch(url, options);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.details || j?.error || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return j;
}

function buildOtherProposalPrompt(slot) {
  const label = getSlotLabel(slot);
  return (
    `Propose une AUTRE recette pour ${label}.\n` +
    `Contraintes: 3 personnes (2 adultes + 1 enfant 9 ans), hiver, simple, budget Lidl/Carrefour.\n` +
    `Réponds en 1 ligne: "Titre - idée rapide".`
  );
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function formatDateFr(dateStr) {
  if (!dateStr) return "";
  const d = new Date(dateStr + "T00:00:00");
  const s = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric"
  }).format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function getWeekId(dateStr) {
  const d = new Date(dateStr + "T00:00:00");
  const target = new Date(d.valueOf());
  const dayNr = (d.getDay() + 6) % 7;
  target.setDate(target.getDate() - dayNr + 3);
  const firstThursday = target.valueOf();
  target.setMonth(0, 1);
  if (target.getDay() !== 4) {
    target.setMonth(0, 1 + ((4 - target.getDay()) + 7) % 7);
  }
  const week = 1 + Math.ceil((firstThursday - target) / 604800000);
  const year = d.getFullYear();
  return `${year}-W${String(week).padStart(2, "0")}`;
}

export default function CockpitWeek() {
  // --------------------
  // State
  // --------------------
  const [weekIds, setWeekIds] = useState([]);
  const [selectedWeekId, setSelectedWeekId] = useState("");
  const [week, setWeek] = useState(null);

  const [selectedSlot, setSelectedSlot] = useState(null);

  const [recipe, setRecipe] = useState(null);
  const [recipeTitles, setRecipeTitles] = useState({});

  const [constraintsOpen, setConstraintsOpen] = useState(false);
  const [constraints, setConstraints] = useState(null);

  const [menuProposals, setMenuProposals] = useState({});
  const [savedProposalIds, setSavedProposalIds] = useState({});

  // Champ libre local (UI only pour l’instant)
  const [freeTextBySlot, setFreeTextBySlot] = useState({});

  // Prepare week UI
  const [prepWeekId, setPrepWeekId] = useState("");
  const [prepStart, setPrepStart] = useState("");
  const [prepEnd, setPrepEnd] = useState("");

  // --------------------
  // Derived
  // --------------------
  const tableRows = useMemo(() => {
    const slotsObj = week?.slots || {};
    return ALL_SLOTS.map((slot) => [slot, slotsObj[slot] || null]);
  }, [week]);

  // --------------------
  // Loaders
  // --------------------
  async function loadWeeksList() {
    const j = await fetchJson("/api/weeks/list");
    setWeekIds(j.week_ids || []);
  }

  async function loadCurrentWeek() {
    const w = await fetchJson("/api/weeks/current");
    setWeek(w);
    setSelectedWeekId(w.week_id);
    return w;
  }

  async function loadWeek(weekId) {
    const w = await fetchJson(`/api/weeks/${encodeURIComponent(weekId)}`);
    setWeek(w);
    setSelectedWeekId(w.week_id);
    return w;
  }

  async function loadConstraints(weekId) {
    const c = await fetchJson(
      `/api/weeks/${encodeURIComponent(weekId)}/constraints`
    );
    setConstraints(c);
  }

  async function loadRecipe(recipeId) {
    if (!recipeId) {
      setRecipe(null);
      return;
    }
    const r = await fetchJson(`/api/recipes/${encodeURIComponent(recipeId)}`);
    setRecipe(r);
    setRecipeTitles((p) => ({ ...p, [recipeId]: r.title || recipeId }));
  }

  async function loadMenuProposals(weekId) {
    try {
      const j = await fetchJson(
        `/api/chat/proposals?week_id=${encodeURIComponent(weekId)}`
      );
      setMenuProposals(j.menu_proposals || {});
    } catch {
      setMenuProposals({});
    }
  }

  // --------------------
  // Init
  // --------------------
  useEffect(() => {
    (async () => {
      await loadWeeksList();
      const w = await loadCurrentWeek();

      const first =
        ALL_SLOTS.find((k) => (w?.slots?.[k]?.validated === true)) ||
        ALL_SLOTS.find((k) => w?.slots?.[k]?.recipe_id) ||
        "mon_dinner";

      setSelectedSlot(first);

      if (w?.slots?.[first]?.validated === true) {
        await loadRecipe(w?.slots?.[first]?.recipe_id || null);
      } else {
        setRecipe(null);
      }

      await loadMenuProposals(w.week_id);
    })();
  }, []);

  useEffect(() => {
    if (!selectedSlot || !week?.slots) return;
    const s = week.slots[selectedSlot] || null;
    if (s?.validated === true) loadRecipe(s?.recipe_id || null);
    else setRecipe(null);
  }, [selectedSlot, week]);

  // --------------------
  // Actions
  // --------------------
  async function onChangeWeek(id) {
    const w = await loadWeek(id);

    const first =
      ALL_SLOTS.find((k) => (w?.slots?.[k]?.validated === true)) ||
      ALL_SLOTS.find((k) => w?.slots?.[k]?.recipe_id) ||
      "mon_dinner";

    setSelectedSlot(first);
    await loadMenuProposals(w.week_id);
  }

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
    await onChangeWeek(prepWeekId);

    setPrepWeekId("");
    setPrepStart("");
    setPrepEnd("");
  }

  async function onValidateProposal(slot, proposal) {
    const j = await fetchJson(
      `/api/weeks/${encodeURIComponent(week.week_id)}/slots/${encodeURIComponent(
        slot
      )}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          recipe_id: proposal.recipe_id || null,
          free_text: proposal.title || ""
        })
      }
    );

    setWeek(j.week);

    if (slot === selectedSlot) {
      const s = j.week?.slots?.[slot] || null;
      if (s?.validated === true) await loadRecipe(s?.recipe_id || null);
      else setRecipe(null);
    }

    await loadMenuProposals(week.week_id);
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

  function onSaveProposal(p) {
    setSavedProposalIds((x) => ({ ...x, [p.proposal_id]: true }));
  }

  function validatedLabel(s) {
    if (!s || s.validated !== true) return "";
    if (s.recipe_id) return recipeTitles[s.recipe_id] || s.recipe_id;
    if (s.free_text) return s.free_text;
    return "";
  }

  // --------------------
  // Render
  // --------------------
  return (
    <div style={{ padding: 16 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Cockpit semaine</h2>

        <select
          value={selectedWeekId}
          onChange={(e) => onChangeWeek(e.target.value)}
        >
          {weekIds.map((id) => (
            <option key={id}>{id}</option>
          ))}
        </select>

        <input type="text" placeholder="Week ID" value={prepWeekId} readOnly />
        <input
          type="date"
          value={prepStart}
          onChange={(e) => {
            const start = e.target.value;
            if (!start) return;
            setPrepStart(start);
            setPrepEnd(addDays(start, 6));
            setPrepWeekId(getWeekId(start));
          }}
        />
        <input
          type="date"
          value={prepEnd}
          onChange={(e) => setPrepEnd(e.target.value)}
        />

        <button onClick={onPrepareWeek}>Préparer</button>
        <button
          onClick={() =>
            loadConstraints(week.week_id).then(() => setConstraintsOpen(true))
          }
          disabled={!week?.week_id}
        >
          Contraintes
        </button>
      </div>

      {week?.date_start && week?.date_end && (
        <div style={{ marginTop: 8, opacity: 0.8 }}>
          Semaine du {formatDateFr(week.date_start)} au {formatDateFr(week.date_end)}
        </div>
      )}

      <table style={{ width: "100%", marginTop: 16 }}>
        <tbody>
          {tableRows.map(([slot, s]) => {
            const isSelected = selectedSlot === slot;
            const isValidated = s?.validated === true;

            const canFreeText = FREE_TEXT_ALLOWED_SLOTS.has(slot) && !isValidated;
            const showProposals = !isValidated;

            const proposals = menuProposals?.[slot] || [];

            return (
              <tr
                key={slot}
                onClick={() => setSelectedSlot(slot)}
                style={{ background: isSelected ? "#eef2ff" : "" }}
              >
                <td style={{ width: 220, verticalAlign: "top", padding: "8px 6px" }}>
                  {getSlotLabel(slot)}
                </td>

                <td style={{ verticalAlign: "top", padding: "8px 6px" }}>
                  {isValidated ? (
                    <strong>{validatedLabel(s)}</strong>
                  ) : (
                    <>
                      {canFreeText && (
                        <textarea
                          style={{ display: "block", width: "100%", marginTop: 6 }}
                          rows={2}
                          value={freeTextBySlot[slot] || ""}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) =>
                            setFreeTextBySlot((prev) => ({
                              ...prev,
                              [slot]: e.target.value
                            }))
                          }
                        />
                      )}

                      {showProposals &&
                        proposals.map((p) => {
                          const saved = !!savedProposalIds[p.proposal_id];
                          return (
                            <div
                              key={p.proposal_id}
                              style={{
                                display: "flex",
                                gap: 8,
                                marginTop: 6,
                                alignItems: "center"
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <span style={{ flex: 1 }}>{p.title}</span>

                              <button onClick={() => onValidateProposal(slot, p)}>
                                Valider
                              </button>

                              <button onClick={() => onOtherProposal(slot)}>
                                Autre
                              </button>

                              <button
                                onClick={() => onSaveProposal(p)}
                                disabled={saved}
                              >
                                Sauvegarder
                              </button>
                            </div>
                          );
                        })}
                    </>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {constraintsOpen && (
        <pre onClick={() => setConstraintsOpen(false)}>
{JSON.stringify(constraints, null, 2)}
        </pre>
      )}
    </div>
  );
}
