import { Link } from "react-router-dom";
import { useEffect, useMemo, useState } from "react";

const WEEKDAYS_FR = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const SLOT_LABELS = { lunch: "Déj", dinner: "Dîn" };

async function fetchJson(url, options) {
  const r = await fetch(url, options);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j?.details || j?.error || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return j;
}

function dateKey(d) {
  return d.toISOString().slice(0, 10);
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function startOfCalendar(monthDate) {
  const first = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const day = first.getDay(); // 0 Sun ... 6 Sat
  const mondayIndex = (day + 6) % 7; // 0 for Monday
  return addDays(first, -mondayIndex);
}

function slotPrefixFromDate(d) {
  const map = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return map[d.getDay()];
}

function totalPeopleFromSlot(slotData) {
  if (!slotData?.people) return 0;
  const adults = Number.isFinite(slotData.people.adults) ? slotData.people.adults : 0;
  const children = Number.isFinite(slotData.people.children) ? slotData.people.children : 0;
  return adults + children;
}

export default function Home() {
  const [currentMonth, setCurrentMonth] = useState(
    new Date(new Date().getFullYear(), new Date().getMonth(), 1)
  );
  const [weeks, setWeeks] = useState({});
  const [recipeCache, setRecipeCache] = useState({});
  const [modal, setModal] = useState(null); // { title, recipe, dateLabel }
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState(null);
  const [calendarMaxHeight, setCalendarMaxHeight] = useState(() => {
    if (typeof window === "undefined") return 440;
    const h = Math.round(window.innerHeight * 0.6);
    return Math.max(360, Math.min(560, h));
  });

  useEffect(() => {
    async function loadWeeks() {
      const { week_ids = [] } = await fetchJson("/api/weeks/list");
      const data = {};
      await Promise.all(
        week_ids.map(async (id) => {
          const w = await fetchJson(`/api/weeks/${encodeURIComponent(id)}`);
          data[id] = w;
        })
      );
      setWeeks(data);
    }

    loadWeeks().catch(() => setWeeks({}));
  }, []);

  useEffect(() => {
    function onResize() {
      const h = Math.round(window.innerHeight * 0.6);
      setCalendarMaxHeight(Math.max(360, Math.min(560, h)));
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const days = useMemo(() => {
    const start = startOfCalendar(currentMonth);
    return Array.from({ length: 42 }, (_, i) => addDays(start, i));
  }, [currentMonth]);

  const dayMap = useMemo(() => {
    const map = {};
    Object.values(weeks).forEach((w) => {
      if (!w?.date_start || !w?.date_end) return;
      const start = new Date(`${w.date_start}T00:00:00`);
      const end = new Date(`${w.date_end}T00:00:00`);
      for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
        const key = dateKey(d);
        const prefix = slotPrefixFromDate(d);
        const lunchKey = `${prefix}_lunch`;
        const dinnerKey = `${prefix}_dinner`;
        map[key] = {
          week_id: w.week_id,
          lunch: { slot: lunchKey, data: w.slots?.[lunchKey] || null },
          dinner: { slot: dinnerKey, data: w.slots?.[dinnerKey] || null }
        };
      }
    });
    return map;
  }, [weeks]);

  async function openRecipeModal(dayLabel, slotLabel, slotData, weekId, slotKey) {
    if (!slotData) return;
    let latestSlotData = slotData;
    if (weekId && slotKey) {
      try {
        const w = await fetchJson(`/api/weeks/${encodeURIComponent(weekId)}`);
        setWeeks((prev) => ({ ...prev, [weekId]: w }));
        latestSlotData = w.slots?.[slotKey] || slotData;
      } catch {
        latestSlotData = slotData;
      }
    }

    const recipeId = latestSlotData.recipe_id || null;
    const freeText = latestSlotData.free_text || "";
    const isValidated =
      latestSlotData.validated === true ||
      (latestSlotData.validated == null &&
        !!(latestSlotData.recipe_id || latestSlotData.free_text));

    setModalLoading(true);
    setModalError(null);

    if (!isValidated) {
      setModal({
        title: "Aucune recette validée",
        recipe: null,
        dateLabel: dayLabel,
        slotLabel,
        people: latestSlotData.people || null,
        isValidated: false
      });
      setModalLoading(false);
      return;
    }

    if (recipeId) {
      const cached = recipeCache[recipeId];
      if (cached) {
        setModal({
          title: cached.title || recipeId,
          recipe: cached,
          dateLabel: dayLabel,
          slotLabel,
          people: latestSlotData.people || null,
          isValidated: true
        });
        setModalLoading(false);
        return;
      }
      try {
        const r = await fetchJson(`/api/recipes/${encodeURIComponent(recipeId)}`);
        setRecipeCache((prev) => ({ ...prev, [recipeId]: r }));
        setModal({
          title: r.title || recipeId,
          recipe: r,
          dateLabel: dayLabel,
          slotLabel,
          people: latestSlotData.people || null,
          isValidated: true
        });
      } catch (e) {
        setModalError(e.message);
      } finally {
        setModalLoading(false);
      }
      return;
    }

    if (freeText) {
      try {
        const j = await fetchJson("/api/chat/preview-title", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: freeText, people: latestSlotData.people || null })
        });
        const preview = j.preview || {};
        setModal({
          title: freeText,
          recipe: { title: freeText, content: preview },
          dateLabel: dayLabel,
          slotLabel,
          people: latestSlotData.people || null,
          isValidated: true
        });
      } catch (e) {
        setModalError(e.message);
      } finally {
        setModalLoading(false);
      }
      return;
    }

    setModal({
      title: "Aucune recette validée",
      recipe: null,
      dateLabel: dayLabel,
      slotLabel,
      people: latestSlotData.people || null,
      isValidated: false
    });
    setModalLoading(false);
  }

  function closeModal() {
    setModal(null);
    setModalError(null);
    setModalLoading(false);
  }

  const monthLabel = new Intl.DateTimeFormat("fr-FR", {
    month: "long",
    year: "numeric"
  }).format(currentMonth);

  return (
    <div style={{ padding: 24 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button onClick={() => setCurrentMonth(new Date())}>Aujourd'hui</button>
        <button onClick={() => setCurrentMonth(addDays(currentMonth, -30))}>‹</button>
        <div style={{ fontSize: 20, fontWeight: 700 }}>{monthLabel}</div>
        <button onClick={() => setCurrentMonth(addDays(currentMonth, 30))}>›</button>

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <Link to="/weeks" style={{ textDecoration: "none" }}>
            <button>Menus hebdo</button>
          </Link>
          <Link to="/tokens" style={{ textDecoration: "none" }}>
            <button>Tokens</button>
          </Link>
        </div>
      </div>

      <div
        style={{
          marginTop: 12,
          maxHeight: calendarMaxHeight,
          overflowY: "auto",
          paddingRight: 4
        }}
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(7, 1fr)",
            gap: 6
          }}
        >
          {WEEKDAYS_FR.map((d) => (
            <div key={d} style={{ fontWeight: 700, textAlign: "center", fontSize: 12 }}>
              {d}
            </div>
          ))}

          {days.map((d) => {
            const key = dateKey(d);
            const info = dayMap[key] || null;
            const isCurrentMonth = d.getMonth() === currentMonth.getMonth();
            const today = new Date();
            const isToday = dateKey(d) === dateKey(today);
            const dayLabel = d.getDate();
            const dayFull = new Intl.DateTimeFormat("fr-FR", {
              weekday: "long",
              day: "2-digit",
              month: "long",
              year: "numeric"
            }).format(d);

            return (
              <div
                key={key}
                style={{
                  height: 86,
                  border: "1px solid #e5e7eb",
                  borderRadius: 6,
                  padding: 6,
                  background: isToday ? "#dceeff" : isCurrentMonth ? "#fff" : "#f9fafb",
                  overflow: "hidden"
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <div style={{ fontWeight: 700, fontSize: 12 }}>{dayLabel}</div>
                  {info?.week_id && (
                    <div style={{ fontSize: 10, opacity: 0.6 }}>{info.week_id}</div>
                  )}
                </div>

                <div style={{ marginTop: 4, display: "grid", gap: 3 }}>
                  {["lunch", "dinner"].map((k) => {
                    const slot = info?.[k]?.slot || null;
                    const data = info?.[k]?.data || null;
                    const label = SLOT_LABELS[k];
                    const title = data?.free_text || data?.recipe_id || "";

                  return (
                    <div
                      key={`${key}-${k}`}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 4,
                        padding: "3px 5px",
                        borderRadius: 5,
                        background: "#f3f4f6",
                        cursor: data ? "pointer" : "default"
                      }}
                      onClick={() => {
                        if (!data) return;
                        openRecipeModal(dayFull, label, data);
                      }}
                    >
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 700,
                          width: 26,
                          opacity: 0.7
                        }}
                      >
                        {label}
                      </div>
                      <div
                        style={{
                          fontSize: 11,
                          whiteSpace: "normal",
                          wordBreak: "break-word",
                          flex: 1
                        }}
                      >
                        {title || "—"}
                      </div>
                    </div>
                  );
                })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {modal && (
        <div
          onClick={closeModal}
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
              <div style={{ fontWeight: 800 }}>
                {modal.dateLabel} — {modal.slotLabel}
              </div>
              <button
                onClick={closeModal}
                aria-label="Fermer"
                style={{
                  marginLeft: "auto",
                  padding: 0,
                  fontSize: 18,
                  lineHeight: 1,
                  background: "transparent",
                  border: "none",
                  cursor: "pointer"
                }}
              >
                x
              </button>
            </div>

            {modalLoading && (
              <div style={{ marginTop: 8, opacity: 0.8 }}>Chargement...</div>
            )}
            {modalError && (
              <div style={{ marginTop: 8, color: "#a00" }}>{modalError}</div>
            )}

            {!modalLoading && !modalError && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 18, fontWeight: 700 }}>{modal.title}</div>
                {(() => {
                  const total = totalPeopleFromSlot({ people: modal?.people || null });
                  return total ? (
                    <div style={{ marginTop: 4, fontSize: 12, opacity: 0.75 }}>
                      Pour {total} personne(s)
                    </div>
                  ) : null;
                })()}
                {modal?.isValidated === false && (
                  <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
                    Aucune recette validée pour ce repas.
                  </div>
                )}
                {modal.recipe?.content?.description_courte && (
                  <div style={{ marginTop: 8, fontSize: 13, opacity: 0.9 }}>
                    {modal.recipe.content.description_courte}
                  </div>
                )}
                {Array.isArray(modal.recipe?.content?.ingredients) &&
                  modal.recipe.content.ingredients.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>
                        Ingrédients
                      </div>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {modal.recipe.content.ingredients.map((ing, idx) => (
                          <li key={idx} style={{ fontSize: 13 }}>
                            {ing.qty} {ing.unit} {ing.item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                {Array.isArray(modal.recipe?.content?.preparation_steps) &&
                  modal.recipe.content.preparation_steps.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>
                        Préparation
                      </div>
                      <ol style={{ margin: 0, paddingLeft: 18 }}>
                        {modal.recipe.content.preparation_steps.map((step, idx) => (
                          <li key={idx} style={{ fontSize: 13 }}>
                            {step}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
