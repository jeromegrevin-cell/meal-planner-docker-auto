import { useNavigate } from "react-router-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import IconButton from "../components/IconButton.jsx";

const WEEKDAYS_FR = ["Lun", "Mar", "Mer", "Jeu", "Ven", "Sam", "Dim"];
const SLOT_LABELS = { lunch: "Déj", dinner: "Dîn" };

const CONSTRAINTS_SECTIONS = [
  {
    title: "1) Rythme des repas (structure semaine)",
    items: [
      "Pas de déjeuner : lundi, mardi, jeudi, vendredi.",
      "Les autres repas (midis + soirs) doivent être remplis ou marqués “reste / congélateur”."
    ]
  },
  {
    title: "2) Personnes et portions",
    items: [
      "Menus pour 3 personnes : 2 adultes + 1 enfant de 9 ans.",
      "Quantités adaptées (pas un simple x3).",
      "Différences adulte/enfant précisées si nécessaires."
    ]
  },
  {
    title: "3) Calories et nutrition",
    items: [
      "Objectif ~500 kcal par repas (adulte).",
      "Pas de dérive excessive pour l’enfant.",
      "Pas de menus vides ou déséquilibrés (ex: soupe seule)."
    ]
  },
  {
    title: "4) Saison et ingrédients",
    items: [
      "Uniquement des légumes de saison.",
      "Courgette interdite hors saison.",
      "Équivalences cru/cuit : pâtes x2,5 ; riz x3 ; semoule x2 ; légumineuses x3 ; pommes de terre x1 ; patate douce x1."
    ]
  },
  {
    title: "5) Répétition des ingrédients (règle clé)",
    items: [
      "Un ingrédient principal max 2 fois/semaine.",
      "Si 2 fois → minimum 2 jours d’écart.",
      "Aucune exception implicite."
    ]
  },
  {
    title: "6) Sources des recettes",
    items: [
      "Mélanger recettes générées + recettes Google Drive / Recettes.",
      "Avant de commencer : demander si l’index Drive est à jour ; sinon proposer un rescan."
    ]
  },
  {
    title: "7) Présentation des listes de courses",
    items: [
      "Liste de courses obligatoire après validation des menus.",
      "Format : tableau (Ingrédient / Quantité / Recettes concernées).",
      "Élimination explicite des ingrédients inutiles.",
      "Vérification croisée : aucun ingrédient sans recette, aucune recette sans ingrédient."
    ]
  },
  {
    title: "8) Budget (option par défaut)",
    items: [
      "Menu hebdomadaire complet, budget cible ≤ 60 EUR (Lidl + Carrefour).",
      "Coûts cohérents avec les tickets mémorisés."
    ]
  },
  {
    title: "9) Règles de qualité (non négociables)",
    items: [
      "Double vérification : verticale (conformité) + horizontale (cohérence globale).",
      "Zéro ingrédient fantôme, zéro approximation silencieuse.",
      "Si erreur détectée → correction immédiate, sans justification défensive."
    ]
  }
];

let authInFlight = null;

async function ensureAuth() {
  if (authInFlight) return authInFlight;
  const password = window.prompt("Mot de passe requis pour accéder à l’API :");
  if (!password) throw new Error("auth_cancelled");

  authInFlight = fetchJson("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
    _noAuthRetry: true
  }).finally(() => {
    authInFlight = null;
  });

  return authInFlight;
}

async function fetchJson(url, options = {}) {
  const { _retried, _noAuthRetry, ...fetchOptions } = options;
  const r = await fetch(url, { ...fetchOptions, credentials: "include" });
  const j = await r.json().catch(() => ({}));
  if (r.status === 401 && !_retried && !_noAuthRetry) {
    await ensureAuth();
    return fetchJson(url, { ...options, _retried: true });
  }
  if (!r.ok) {
    const msg = j?.details || j?.error || `HTTP ${r.status}`;
    throw new Error(msg);
  }
  return j;
}

function dateKey(d) {
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addDays(d, n) {
  const x = new Date(d);
  x.setDate(x.getDate() + n);
  return x;
}

function addMonths(d, n) {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function startOfWeekMonday(dateObj) {
  const d = new Date(dateObj);
  const day = d.getDay(); // 0 Sun ... 6 Sat
  const mondayIndex = (day + 6) % 7; // 0 for Monday
  return addDays(d, -mondayIndex);
}

function endOfWeekSunday(dateObj) {
  const d = new Date(dateObj);
  const day = d.getDay(); // 0 Sun ... 6 Sat
  const sundayIndex = (7 - day) % 7;
  return addDays(d, sundayIndex);
}

function slotPrefixFromDate(d) {
  const map = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return map[d.getDay()];
}

function formatDateTime(value) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(d);
}

function totalPeopleFromSlot(slotData) {
  if (!slotData?.people) return 0;
  const adults = Number.isFinite(slotData.people.adults) ? slotData.people.adults : 0;
  const children = Number.isFinite(slotData.people.children) ? slotData.people.children : 0;
  return adults + children;
}

export default function Home() {
  const navigate = useNavigate();
  const todayRef = new Date();
  const [currentMonth, setCurrentMonth] = useState(
    new Date(todayRef.getFullYear(), todayRef.getMonth(), 1)
  );
  const [selectedDateKey, setSelectedDateKey] = useState(dateKey(todayRef));
  const [weeks, setWeeks] = useState({});
  const [recipeCache, setRecipeCache] = useState({});
  const [modal, setModal] = useState(null); // { title, recipe, dateLabel }
  const [modalLoading, setModalLoading] = useState(false);
  const [modalError, setModalError] = useState(null);
  const [constraintsOpen, setConstraintsOpen] = useState(false);
  const [rescanRequired, setRescanRequired] = useState(false);
  const [rescanStatus, setRescanStatus] = useState(null);
  const [calendarMaxHeight, setCalendarMaxHeight] = useState(() => {
    if (typeof window === "undefined") return 440;
    const h = Math.round(window.innerHeight * 0.6);
    const row = 86;
    const gap = 6;
    const header = 24;
    const rows = Math.max(2, Math.min(6, Math.floor(h / (row + gap))));
    return rows * (row + gap) - gap + header;
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

  const loadRescanStatus = useCallback(async (opts = {}) => {
    try {
      const status = await fetchJson("/api/drive/rescan/status");
      setRescanStatus(status);
      setRescanRequired(Boolean(status?.rescan_required));
    } catch {
      if (!opts.silent) setRescanRequired(false);
    }
  }, []);

  useEffect(() => {
    loadRescanStatus({ silent: true });
  }, [loadRescanStatus]);

  useEffect(() => {
    if (rescanStatus?.latest?.status !== "running") return;
    const id = window.setInterval(() => {
      loadRescanStatus({ silent: true });
    }, 3000);
    return () => window.clearInterval(id);
  }, [loadRescanStatus, rescanStatus?.latest?.status]);

  useEffect(() => {
    function onResize() {
      const h = Math.round(window.innerHeight * 0.6);
      const row = 86;
      const gap = 6;
      const header = 24;
      const rows = Math.max(2, Math.min(6, Math.floor(h / (row + gap))));
      setCalendarMaxHeight(rows * (row + gap) - gap + header);
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const days = useMemo(() => {
    const monthStart = new Date(currentMonth.getFullYear(), currentMonth.getMonth(), 1);
    const monthEnd = new Date(currentMonth.getFullYear(), currentMonth.getMonth() + 1, 0);
    const start = startOfWeekMonday(monthStart);
    const end = endOfWeekSunday(monthEnd);
    const out = [];
    for (let d = new Date(start); d <= end; d = addDays(d, 1)) {
      out.push(new Date(d));
    }
    return out;
  }, [currentMonth]);

  const calendarWeeks = useMemo(() => {
    const out = [];
    for (let i = 0; i < days.length; i += 7) {
      out.push(days.slice(i, i + 7));
    }
    return out;
  }, [days]);

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

  async function onRescanDrive() {
    try {
      await fetchJson("/api/drive/rescan", { method: "POST" });
      await loadRescanStatus({ silent: true });
    } catch (e) {
      alert(`Rescan Drive failed: ${e.message}`);
    }
  }

  const monthLabel = new Intl.DateTimeFormat("fr-FR", {
    month: "long",
    year: "numeric"
  }).format(currentMonth);

  const calendarRef = useRef(null);
  const weekRefs = useRef([]);
  const calendarHeaderHeight = 24;
  const calendarHeaderGap = 6;

  useEffect(() => {
    const idx = days.findIndex((d) => dateKey(d) === selectedDateKey);
    if (idx < 0) return;
    const weekIdx = Math.floor(idx / 7);
    const target = weekRefs.current[weekIdx];
    if (target) {
      target.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  }, [days, selectedDateKey]);

  return (
    <div className="page">
      <div className="toolbar">
        <button
          onClick={() => {
            const now = new Date();
            setCurrentMonth(new Date(now.getFullYear(), now.getMonth(), 1));
            setSelectedDateKey(dateKey(now));
          }}
        >
          Aujourd'hui
        </button>
        <IconButton
          icon="‹"
          label="Mois précédent"
          onClick={() => setCurrentMonth(addMonths(currentMonth, -1))}
        />
        <div className="toolbar-title">{monthLabel}</div>
        <IconButton
          icon="›"
          label="Mois suivant"
          onClick={() => setCurrentMonth(addMonths(currentMonth, 1))}
        />

        <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            onClick={() => navigate("/weeks")}
            className="btn-primary"
          >
            Générer semaine
          </button>
        </div>
      </div>

      <div style={{ marginTop: 12 }}>
        <div
          ref={calendarRef}
          className="calendar-shell"
          style={{
            maxHeight: calendarMaxHeight,
            overflowY: "auto",
            paddingRight: 4,
            scrollSnapType: "y mandatory",
            scrollPaddingTop: calendarHeaderHeight + calendarHeaderGap
          }}
        >
          <div
            style={{
              position: "sticky",
              top: 0,
              background: "var(--bg-elev)",
              zIndex: 2,
              paddingBottom: calendarHeaderGap
            }}
          >
            <div style={{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 6 }}>
              {WEEKDAYS_FR.map((d) => (
                <div key={d} className="weekday-chip">
                  {d}
                </div>
              ))}
            </div>
          </div>
          <div style={{ display: "grid", gap: 6, paddingTop: calendarHeaderHeight + calendarHeaderGap }}>
            {calendarWeeks.map((week, widx) => (
              <div
                key={`week-${widx}`}
                ref={(el) => {
                  weekRefs.current[widx] = el;
                }}
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(7, 1fr)",
                  gap: 6,
                  scrollSnapAlign: "start",
                  scrollSnapStop: "always",
                  scrollMarginTop: calendarHeaderHeight + calendarHeaderGap
                }}
              >
                {week.map((d) => {
                  const key = dateKey(d);
                  const info = dayMap[key] || null;
                  const isCurrentMonth = d.getMonth() === currentMonth.getMonth();
                  const today = new Date();
                  const isToday = dateKey(d) === dateKey(today);
                  const isSelected = selectedDateKey === key;
                  const dayLabel = new Intl.DateTimeFormat("fr-FR", {
                    weekday: "long",
                    day: "numeric"
                  }).format(d);
                  const dayFull = new Intl.DateTimeFormat("fr-FR", {
                    weekday: "long",
                    day: "2-digit",
                    month: "long",
                    year: "numeric"
                  }).format(d);
                  const dayLabelCap =
                    dayLabel.charAt(0).toUpperCase() + dayLabel.slice(1);

                  return (
                    <div
                      key={key}
                      className={[
                        "day-card",
                        isSelected ? "day-card-selected" : "",
                        isToday ? "day-card-today" : "",
                        !isCurrentMonth ? "day-card-outside" : ""
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => {
                        setSelectedDateKey(key);
                        setCurrentMonth(new Date(d.getFullYear(), d.getMonth(), 1));
                      }}
                    >
                      <div style={{ display: "flex", justifyContent: "space-between" }}>
                        <div style={{ fontWeight: 600, fontSize: 12 }}>{dayLabelCap}</div>
                        {info?.week_id && (
                          <div style={{ fontSize: 10 }} className="muted">
                            {info.week_id}
                          </div>
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
                              className="slot-pill"
                              style={{ cursor: data ? "pointer" : "default" }}
                              onClick={(e) => {
                                e.stopPropagation();
                                if (!data) return;
                                openRecipeModal(dayFull, label, data);
                              }}
                            >
                              <div
                                style={{
                                  fontSize: 10,
                                  fontWeight: 600,
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
            ))}
          </div>
        </div>
      </div>

      <div style={{ marginTop: 12, display: "flex", justifyContent: "space-between" }}>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 4 }}>
          <button
            onClick={() => setConstraintsOpen(true)}
            className="btn-ghost"
            style={{ fontSize: 12, padding: "4px 8px" }}
          >
            Contraintes
          </button>
        </div>
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 4 }}>
          <button
            onClick={onRescanDrive}
            disabled={rescanStatus?.latest?.status === "running"}
          >
            {rescanStatus?.latest?.status === "running" ? "Rescan en cours…" : "Rescan recettes"}
            {rescanRequired ? " ⚠️" : ""}
          </button>
          {rescanStatus?.progress?.total ? (
            (() => {
              const scanned = rescanStatus.progress.scanned || 0;
              const total = rescanStatus.progress.total || 0;
              const pct = total ? Math.min(100, Math.max(0, Math.round((scanned / total) * 100))) : 0;
              const isRunning = rescanStatus?.latest?.status === "running";
              return (
                <div style={{ width: 220 }}>
                  <div style={{ fontSize: 12 }} className="muted">
                    {isRunning ? "Rescan en cours" : "Dernier rescan"} : {scanned}/{total} ({pct}%)
                  </div>
                  <div
                    style={{
                      marginTop: 4,
                      height: 6,
                      borderRadius: 999,
                      background: "#e6e0d7",
                      overflow: "hidden"
                    }}
                  >
                    <div
                      style={{
                        width: `${pct}%`,
                        height: "100%",
                        background: isRunning ? "var(--accent)" : "#9aa3ad",
                        transition: "width 200ms ease"
                      }}
                    />
                  </div>
                </div>
              );
            })()
          ) : null}
          {formatDateTime(rescanStatus?.last_rescan_at) ? (
            <div style={{ fontSize: 12, opacity: 0.75 }}>
              Dernier rescan : {formatDateTime(rescanStatus?.last_rescan_at)}
            </div>
          ) : null}
        </div>
      </div>

      {modal && (
        <div onClick={closeModal} className="modal-overlay">
          <div
            onClick={(e) => e.stopPropagation()}
            className="modal"
            style={{
              width: "min(760px, 96vw)",
              padding: 16
            }}
          >
            <div style={{ display: "flex", alignItems: "center" }}>
              <div className="modal-title">
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
              <div style={{ marginTop: 8 }} className="status-loading">
                Chargement...
              </div>
            )}
            {modalError && (
              <div style={{ marginTop: 8 }} className="status-error">
                {modalError}
              </div>
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

            <div style={{ marginTop: 10, fontSize: 13 }}>
              {CONSTRAINTS_SECTIONS.map((section) => (
                <div key={section.title} style={{ marginBottom: 10 }}>
                  <div style={{ fontWeight: 700, marginBottom: 4 }}>
                    {section.title}
                  </div>
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {section.items.map((line, idx) => (
                      <li key={idx} style={{ marginBottom: 6 }}>
                        {line}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
