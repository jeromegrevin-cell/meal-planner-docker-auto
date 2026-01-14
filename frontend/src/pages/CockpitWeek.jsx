import React, { useEffect, useMemo, useState } from "react";

// --------------------
// Slots - FR labels + order
// --------------------
const SLOT_LABELS_FR = {
  mon_lunch: "Lundi dejeuner",
  mon_dinner: "Lundi diner",
  tue_lunch: "Mardi dejeuner",
  tue_dinner: "Mardi diner",
  wed_lunch: "Mercredi dejeuner",
  wed_dinner: "Mercredi diner",
  thu_lunch: "Jeudi dejeuner",
  thu_dinner: "Jeudi diner",
  fri_lunch: "Vendredi dejeuner",
  fri_dinner: "Vendredi diner",
  sat_lunch: "Samedi dejeuner",
  sat_dinner: "Samedi diner",
  sun_lunch: "Dimanche dejeuner",
  sun_dinner: "Dimanche diner"
};

const ALL_SLOTS = [
  "mon_lunch",
  "mon_dinner",
  "tue_lunch",
  "tue_dinner",
  "wed_lunch",
  "wed_dinner",
  "thu_lunch",
  "thu_dinner",
  "fri_lunch",
  "fri_dinner",
  "sat_lunch",
  "sat_dinner",
  "sun_lunch",
  "sun_dinner"
];

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
    `Contraintes: 3 personnes (2 adultes + 1 enfant 9 ans), saison hiver, simple, budget Lidl/Carrefour.\n` +
    `Reponds en 1 ligne: "Titre - idee rapide" (pas de liste, pas de menu complet).`
  );
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
  const [recipeTitles, setRecipeTitles] = useState({}); // {recipe_id: title}

  const [constraintsOpen, setConstraintsOpen] = useState(false);
  const [constraints, setConstraints] = useState(null);

  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatWarning, setChatWarning] = useState(null);

  // Proposals from chat (per slot)
  const [menuProposals, setMenuProposals] = useState({});

  // Champ libre local (pour slots sans repas / non proposés)
  const [freeTextBySlot, setFreeTextBySlot] = useState({}); // {slot: text}

  // Prepare week UI
  const [prepWeekId, setPrepWeekId] = useState("");
  const [prepStart, setPrepStart] = useState("");
  const [prepEnd, setPrepEnd] = useState("");

  // Sprint 2.2: saved proposals (MVP local)
  const [savedProposalIds, setSavedProposalIds] = useState({}); // {proposal_id: true}

  // --------------------
  // Derived: rows for table
  // Always show ALL_SLOTS (14 lines)
  // week.slots might not include mon_lunch, etc.
  // --------------------
  const tableRows = useMemo(() => {
    const slotsObj = week?.slots || {};
    return ALL_SLOTS.map((slot) => {
      const s = slotsObj?.[slot] || null; // {recipe_id, free_text} or null
      return [slot, s];
    });
  }, [week]);

  // --------------------
  // Loaders
  // --------------------
  async function loadWeeksList() {
    const j = await fetchJson("/api/weeks/list");
    setWeekIds(j.week_ids || []);
    return j.week_ids || [];
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
    return c;
  }

  async function loadRecipe(recipeId) {
    if (!recipeId) {
      setRecipe(null);
      return null;
    }
    const r = await fetchJson(`/api/recipes/${encodeURIComponent(recipeId)}`);
    setRecipe(r);
    setRecipeTitles((prev) => ({ ...prev, [recipeId]: r.title || recipeId }));
    return r;
  }

  async function loadChat(weekId) {
    if (!weekId) return;
    const j = await fetchJson(
      `/api/chat/current?week_id=${encodeURIComponent(weekId)}`
    );
    setChatMessages(j.messages || []);
    setChatWarning(null);
  }

  async function sendChat(weekId, message, context) {
    const j = await fetchJson("/api/chat/current", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        week_id: weekId,
        message,
        context: context || null
      })
    });
    setChatMessages(j.messages || []);
    setChatWarning(j.warning || null);
    return j;
  }

  async function loadMenuProposals(weekId) {
    if (!weekId) return;
    try {
      const j = await fetchJson(
        `/api/chat/proposals?week_id=${encodeURIComponent(weekId)}`
      );
      setMenuProposals(j.menu_proposals || {});
    } catch (_e) {
      setMenuProposals({});
    }
  }

  // --------------------
  // Init
  // --------------------
  useEffect(() => {
    (async () => {
      try {
        await loadWeeksList();
        const w = await loadCurrentWeek();

        const firstExisting =
          ALL_SLOTS.find((k) => (w?.slots || {})[k]?.recipe_id) || "mon_dinner";
        setSelectedSlot(firstExisting);

        const rid = w?.slots?.[firstExisting]?.recipe_id || null;
        if (rid) await loadRecipe(rid);

        await loadChat(w.week_id);
        await loadMenuProposals(w.week_id);
      } catch (e) {
        console.error(e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When week changes, refresh chat + proposals
  useEffect(() => {
    if (!week?.week_id) return;

    (async () => {
      try {
        await loadChat(week.week_id);
        await loadMenuProposals(week.week_id);

        if (!selectedSlot) setSelectedSlot("mon_dinner");
      } catch (e) {
        console.error(e);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week?.week_id]);

  // When selectedSlot changes, load its recipe if any
  useEffect(() => {
    if (!week?.slots || !selectedSlot) return;
    const rid = week?.slots?.[selectedSlot]?.recipe_id || null;
    if (rid) loadRecipe(rid);
    else setRecipe(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSlot]);

  // --------------------
  // UI actions
  // --------------------
  async function onChangeWeek(id) {
    try {
      const w = await loadWeek(id);

      const firstExisting =
        ALL_SLOTS.find((k) => (w?.slots || {})[k]?.recipe_id) || "mon_dinner";
      setSelectedSlot(firstExisting);

      const rid = w?.slots?.[firstExisting]?.recipe_id || null;
      if (rid) await loadRecipe(rid);
      else setRecipe(null);

      await loadChat(w.week_id);
      await loadMenuProposals(w.week_id);
    } catch (e) {
      console.error(e);
    }
  }

  function onSelectSlot(slot) {
    setSelectedSlot(slot);
  }

  async function onOpenConstraints() {
    if (!week?.week_id) return;
    try {
      await loadConstraints(week.week_id);
      setConstraintsOpen(true);
    } catch (e) {
      console.error(e);
    }
  }

  async function onSendChat() {
    const msg = String(chatInput || "").trim();
    if (!msg || !week?.week_id) return;

    try {
      await sendChat(week.week_id, msg, {
        slot: selectedSlot,
        recipe_id: week?.slots?.[selectedSlot]?.recipe_id || null
      });
      setChatInput("");
      await loadMenuProposals(week.week_id);
    } catch (e) {
      console.error(e);
    }
  }

  function onFreeTextChange(slot, value) {
    setFreeTextBySlot((prev) => ({ ...prev, [slot]: value }));
  }

  async function onPrepareWeek() {
    const week_id = String(prepWeekId || "").trim();
    const date_start = String(prepStart || "").trim();
    const date_end = String(prepEnd || "").trim();

    if (!week_id) return alert("week_id manquant (ex: 2026-W04)");
    if (!date_start) return alert("date_start manquante (YYYY-MM-DD)");
    if (!date_end) return alert("date_end manquante (YYYY-MM-DD)");

    try {
      await fetchJson("/api/weeks/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week_id, date_start, date_end })
      });

      await loadWeeksList();
      await onChangeWeek(week_id);

      setPrepWeekId("");
      setPrepStart("");
      setPrepEnd("");
    } catch (e) {
      alert(`prepare failed: ${e.message}`);
    }
  }

  // Sprint 2.2 actions: validate / other / save
  async function onValidateProposal(slot, proposal) {
    if (!week?.week_id) return;
    try {
      const body = {
        recipe_id: proposal?.recipe_id || null,
        free_text: proposal?.title || ""
      };

      const j = await fetchJson(
        `/api/weeks/${encodeURIComponent(week.week_id)}/slots/${encodeURIComponent(
          slot
        )}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body)
        }
      );

      // update week in UI from response
      const updatedWeek = j.week;
      setWeek(updatedWeek);

      // reload recipe panel if we set recipe_id and slot is selected
      if (slot === selectedSlot) {
        const rid = updatedWeek?.slots?.[slot]?.recipe_id || null;
        if (rid) await loadRecipe(rid);
        else setRecipe(null);
      }

      // refresh proposals (optional)
      await loadMenuProposals(week.week_id);
    } catch (e) {
      alert(`Valider failed: ${e.message}`);
    }
  }

  async function onOtherProposal(slot) {
    if (!week?.week_id) return;
    try {
      const prompt = buildOtherProposalPrompt(slot);
      await sendChat(week.week_id, prompt, {
        slot,
        recipe_id: week?.slots?.[slot]?.recipe_id || null
      });
      await loadMenuProposals(week.week_id);
    } catch (e) {
      alert(`Autre proposition failed: ${e.message}`);
    }
  }

  function onSaveProposal(proposal) {
    const pid = proposal?.proposal_id;
    if (!pid) return;
    setSavedProposalIds((prev) => ({ ...prev, [pid]: true }));
  }

  // --------------------
  // Render helpers
  // --------------------
  function renderSlotCurrentLabel(slot, s) {
    const rid = s?.recipe_id || null;
    const ft = s?.free_text || null;

    if (rid) return recipeTitles?.[rid] || rid;
    if (ft) return ft; // texte validé sans recipe_id
    return ""; // vide
  }

  // --------------------
  // Render
  // --------------------
  return (
    <div style={{ padding: 16, fontFamily: "system-ui, -apple-system, Arial" }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h2 style={{ margin: 0 }}>Cockpit semaine</h2>

        <div
          style={{
            marginLeft: "auto",
            display: "flex",
            gap: 8,
            alignItems: "center",
            flexWrap: "wrap"
          }}
        >
          <select
            value={selectedWeekId}
            onChange={(e) => onChangeWeek(e.target.value)}
            style={{ padding: 6 }}
          >
            {weekIds.map((id) => (
              <option key={id} value={id}>
                {id}
              </option>
            ))}
          </select>

          <input
            value={prepWeekId}
            onChange={(e) => setPrepWeekId(e.target.value)}
            placeholder="week_id (ex: 2026-W04)"
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
          <button onClick={onPrepareWeek} style={{ padding: "6px 10px" }}>
            Preparer
          </button>

          <button onClick={onOpenConstraints} style={{ padding: "6px 10px" }}>
            Contraintes
          </button>
        </div>
      </div>

      {/* Main layout */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "1fr 1fr",
          gap: 16,
          marginTop: 12
        }}
      >
        {/* Left: Week table */}
        <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>
            {week?.week_id || "(semaine)"}{" "}
            <span style={{ fontWeight: 400, opacity: 0.8 }}>
              {week?.date_start ? `${week.date_start} -> ${week.date_end}` : ""}
            </span>
          </div>

          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "1px solid #eee" }}>
                <th style={{ padding: "6px 4px", width: "34%" }}>
                  Jour / repas
                </th>
                <th style={{ padding: "6px 4px" }}>Recette</th>
              </tr>
            </thead>

            <tbody>
              {tableRows.map(([slot, s]) => {
                const isSelected = selectedSlot === slot;

                const rid = s?.recipe_id || null;
                const hasRecipe = !!rid;
                const hasProposals = (menuProposals?.[slot] || []).length > 0;

                return (
                  <tr
                    key={slot}
                    style={{
                      cursor: "pointer",
                      background: isSelected ? "#eef2ff" : "transparent",
                      borderBottom: "1px solid #f2f2f2"
                    }}
                    onClick={() => onSelectSlot(slot)}
                  >
                    <td style={{ padding: "6px 4px" }}>{getSlotLabel(slot)}</td>

                    <td style={{ padding: "6px 4px" }}>
                      {/* Recette actuelle / texte validé */}
                      <div style={{ fontWeight: 600 }}>
                        {renderSlotCurrentLabel(slot, s)}
                      </div>

                      {/* Champ libre local (si pas de recipe_id) */}
                      {!hasRecipe && (
                        <div style={{ marginTop: 6 }}>
                          <textarea
                            value={freeTextBySlot?.[slot] || ""}
                            onChange={(e) =>
                              onFreeTextChange(slot, e.target.value)
                            }
                            onClick={(e) => e.stopPropagation()}
                            placeholder=""
                            rows={2}
                            style={{ width: "100%", padding: 6, fontSize: 12 }}
                          />
                        </div>
                      )}

                      {/* Propositions du chat + boutons */}
                      {hasProposals && (
                        <div style={{ marginTop: 6, fontSize: 12 }}>
                          {(menuProposals?.[slot] || []).map((p) => {
                            const saved = !!savedProposalIds?.[p.proposal_id];
                            return (
                              <div
                                key={p.proposal_id}
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  justifyContent: "space-between",
                                  gap: 8,
                                  padding: "4px 0",
                                  borderTop: "1px dashed #eee"
                                }}
                                onClick={(e) => e.stopPropagation()}
                              >
                                <div style={{ flex: 1, opacity: 0.92 }}>
                                  {p.title}
                                  {saved ? (
                                    <span style={{ marginLeft: 8, opacity: 0.7 }}>
                                      (Sauvegardee)
                                    </span>
                                  ) : null}
                                </div>

                                <div style={{ display: "flex", gap: 6 }}>
                                  <button
                                    style={{ padding: "4px 8px", fontSize: 12 }}
                                    onClick={() => onValidateProposal(slot, p)}
                                  >
                                    Valider
                                  </button>
                                  <button
                                    style={{ padding: "4px 8px", fontSize: 12 }}
                                    onClick={() => onOtherProposal(slot)}
                                  >
                                    Autre
                                  </button>
                                  <button
                                    style={{ padding: "4px 8px", fontSize: 12 }}
                                    onClick={() => onSaveProposal(p)}
                                    disabled={saved}
                                  >
                                    Sauvegarder
                                  </button>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {/* Right: Recipe + Chat */}
        <div style={{ display: "grid", gridTemplateRows: "auto 1fr", gap: 16 }}>
          {/* Recipe panel */}
          <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 12 }}>
            <div style={{ fontWeight: 700, marginBottom: 8 }}>
              Recette (slot: {selectedSlot ? getSlotLabel(selectedSlot) : "-"})
            </div>

            {recipe ? (
              <div>
                <div style={{ fontSize: 16, fontWeight: 700 }}>
                  {recipe.title || recipe.recipe_id}
                </div>
                <div style={{ marginTop: 8, fontSize: 13, opacity: 0.9 }}>
                  {recipe?.content?.description_courte || ""}
                </div>
                {Array.isArray(recipe?.content?.ingredients) &&
                recipe.content.ingredients.length > 0 ? (
                  <div style={{ marginTop: 10 }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>
                      Ingredients
                    </div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {recipe.content.ingredients.map((ing, idx) => (
                        <li key={idx} style={{ fontSize: 13 }}>
                          {ing.qty} {ing.unit} {ing.item}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}
              </div>
            ) : (
              <div style={{ opacity: 0.8 }}>
                Aucune recette liee a ce slot.
              </div>
            )}
          </div>

          {/* Chat panel */}
          <div
            style={{
              border: "1px solid #ddd",
              borderRadius: 8,
              padding: 12,
              minHeight: 320
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <div style={{ fontWeight: 700 }}>Chat</div>
              {chatWarning && (
                <div style={{ fontSize: 12, color: "#a00" }}>
                  warning: {chatWarning}
                </div>
              )}
              <div style={{ marginLeft: "auto", fontSize: 12, opacity: 0.8 }}>
                {week?.week_id ? `week_id=${week.week_id}` : ""}
                {selectedSlot ? `, slot=${selectedSlot}` : ""}
              </div>
            </div>

            <div
              style={{
                marginTop: 10,
                border: "1px solid #eee",
                borderRadius: 8,
                padding: 10,
                height: 220,
                overflow: "auto",
                background: "#fafafa"
              }}
            >
              {chatMessages.length === 0 ? (
                <div style={{ opacity: 0.7 }}>Aucun message.</div>
              ) : (
                chatMessages.map((m, idx) => (
                  <div key={idx} style={{ marginBottom: 10 }}>
                    <div
                      style={{
                        fontSize: 12,
                        fontWeight: 700,
                        opacity: 0.8
                      }}
                    >
                      {m.role}
                    </div>
                    <div style={{ whiteSpace: "pre-wrap", fontSize: 13 }}>
                      {m.content}
                    </div>
                  </div>
                ))
              )}
            </div>

            <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
              <input
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                placeholder="Message..."
                style={{ flex: 1, padding: 8 }}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    onSendChat();
                  }
                }}
              />
              <button onClick={onSendChat} style={{ padding: "8px 12px" }}>
                Envoyer
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Constraints modal (simple) */}
      {constraintsOpen && (
        <div
          onClick={() => setConstraintsOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.25)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              width: "min(760px, 96vw)",
              background: "#fff",
              borderRadius: 10,
              padding: 16,
              border: "1px solid #ddd"
            }}
          >
            <div style={{ display: "flex", alignItems: "center" }}>
              <div style={{ fontWeight: 800 }}>Contraintes</div>
              <button
                onClick={() => setConstraintsOpen(false)}
                style={{ marginLeft: "auto", padding: "6px 10px" }}
              >
                Fermer
              </button>
            </div>

            <div style={{ marginTop: 10, fontSize: 13 }}>
              {constraints ? (
                <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>
{JSON.stringify(constraints, null, 2)}
                </pre>
              ) : (
                <div style={{ opacity: 0.8 }}>Chargement...</div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
