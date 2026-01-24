import React, { useEffect, useMemo, useRef, useState } from "react";
import IconButton from "../components/IconButton.jsx";

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

const PROPOSAL_SLOTS = ALL_SLOTS.filter(
  (slot) => !FREE_TEXT_ALLOWED_SLOTS.has(slot)
);

const DEFAULT_CHILD_BIRTH_MONTH = "2016-08";
const DEFAULT_PEOPLE = {
  adults: 2,
  children: 1,
  child_birth_months: [DEFAULT_CHILD_BIRTH_MONTH]
};

function DriveIcon({ size = 16 }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 87.3 78"
      aria-hidden="true"
      focusable="false"
      style={{ display: "inline-block", verticalAlign: "middle" }}
    >
      <path
        d="M55.2 0H32.1L0 55.6l11.1 19.2 44.1-74.8z"
        fill="#0F9D58"
      />
      <path
        d="M87.3 55.6L55.2 0 11.1 74.8l.1.2h64.9l11.2-19.4z"
        fill="#4285F4"
      />
      <path
        d="M55.2 0L87.3 55.6H32.1L0 55.6 32.1 0h23.1z"
        fill="#FFC107"
      />
    </svg>
  );
}

function getSlotLabel(slotKey) {
  return SLOT_LABELS_FR[slotKey] || slotKey;
}

// --------------------
// Helpers
// --------------------
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

function buildOtherProposalPrompt(slot, people, childAges) {
  const label = getSlotLabel(slot);
  const adults = people?.adults ?? DEFAULT_PEOPLE.adults;
  const children = people?.children ?? DEFAULT_PEOPLE.children;
  const agesText =
    children > 0 && Array.isArray(childAges) && childAges.length > 0
      ? ` (enfant: ${childAges.join(", ")} ans)`
      : "";
  return (
    `Propose une AUTRE recette pour ${label}.\n` +
    `Personnes: ${adults} adulte(s) + ${children} enfant(s)${agesText}.\n` +
    "Rappel contraintes: hiver, simple, budget Lidl/Carrefour, ~500 kcal/adulte, légumes de saison (courgette interdite hors saison).\n" +
    "Répétitions: ingrédient principal max 2 fois/semaine, si 2 fois -> 2 jours d’écart.\n" +
    "Sources: mélanger recettes générées + Drive si possible (demander rescan si index non à jour).\n" +
    `Réponds en 1 ligne: "Titre - idée rapide".`
  );
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function buildWeekIdFromRange(start, end) {
  if (!start || !end) return "";
  const [y1, m1, d1] = start.split("-");
  const [y2, m2, d2] = end.split("-");
  if (!y1 || !m1 || !d1 || !y2 || !m2 || !d2) return "";
  return `${d1}-${m1}_to_${d2}-${m2}_${y1}`;
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

function normalizePeopleFromSlot(slotPeople) {
  if (!slotPeople || typeof slotPeople !== "object") return { ...DEFAULT_PEOPLE };

  const adults = Number.isFinite(slotPeople.adults) ? slotPeople.adults : DEFAULT_PEOPLE.adults;
  const children = Number.isFinite(slotPeople.children) ? slotPeople.children : DEFAULT_PEOPLE.children;

  let child_birth_months = Array.isArray(slotPeople.child_birth_months)
    ? slotPeople.child_birth_months
        .map((s) => String(s))
        .filter((s) => /^\d{4}-\d{2}$/.test(s))
    : [];

  if (child_birth_months.length === 0 && Array.isArray(slotPeople.child_birth_years)) {
    child_birth_months = slotPeople.child_birth_years
      .map((y) => Number(y))
      .filter((y) => Number.isFinite(y))
      .map((y) => `${y}-01`);
  }

  if (children > 0 && child_birth_months.length === 0) {
    child_birth_months = Array(children).fill(DEFAULT_CHILD_BIRTH_MONTH);
  }

  if (children === 0) {
    child_birth_months = [];
  }

  if (child_birth_months.length !== children && children > 0) {
    child_birth_months = Array(children).fill(
      child_birth_months[0] || DEFAULT_CHILD_BIRTH_MONTH
    );
  }

  return { adults, children, child_birth_months };
}

function peopleTotal(people) {
  const adults = Number.isFinite(people?.adults) ? people.adults : 0;
  const children = Number.isFinite(people?.children) ? people.children : 0;
  return adults + children;
}

function slotTotalPeople(weekSlots, slot) {
  if (!slot) return 0;
  const people = normalizePeopleFromSlot(weekSlots?.[slot]?.people);
  return peopleTotal(people);
}

function buildPeopleSignature(people) {
  const adults = Number(people?.adults || 0);
  const children = Number(people?.children || 0);
  const months = Array.isArray(people?.child_birth_months)
    ? people.child_birth_months.map(String)
    : [];
  return `${adults}|${children}|${months.join(",")}`;
}

function buildProposalPreviewKey(proposalId, signature) {
  return `proposal:${proposalId}__${signature}`;
}

function buildRecipePrefetchKey(recipeId) {
  return `recipe:${recipeId}`;
}

function buildFreeTextPrefetchKey(freeText, signature) {
  return `free:${freeText}__${signature}`;
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
  const [recipeCache, setRecipeCache] = useState({});


  const [menuProposals, setMenuProposals] = useState({});
  const [savedRecipeIdsBySlot, setSavedRecipeIdsBySlot] = useState({});
  const [uploadedRecipeIdsBySlot, setUploadedRecipeIdsBySlot] = useState({});
  const [proposalLoadingBySlot, setProposalLoadingBySlot] = useState({});
  const [proposalErrorBySlot, setProposalErrorBySlot] = useState({});

  const [previewCache, setPreviewCache] = useState({});
  const [prefetchStatus, setPrefetchStatus] = useState({});
  const recipePrefetchInFlight = useRef(new Set());
  const previewPrefetchInFlight = useRef(new Set());
  const prefetchTimers = useRef({});

  // Champ libre local (UI only pour l’instant)
  const [freeTextBySlot, setFreeTextBySlot] = useState({});

  // Prepare week UI
  const [prepWeekId, setPrepWeekId] = useState("");
  const [prepStart, setPrepStart] = useState("");
  const [prepEnd, setPrepEnd] = useState("");

  // Proposal modal
  const [proposalModal, setProposalModal] = useState(null); // { slot, proposal }
  const [proposalRecipe, setProposalRecipe] = useState(null);
  const [proposalLoading, setProposalLoading] = useState(false);
  const [proposalError, setProposalError] = useState(null);

  // Validated recipe modal
  const [recipeModal, setRecipeModal] = useState(null); // { slot }
  const [recipeModalData, setRecipeModalData] = useState(null);
  const [recipeModalLoading, setRecipeModalLoading] = useState(false);
  const [recipeModalError, setRecipeModalError] = useState(null);

  // --------------------
  // Derived
  // --------------------
  const tableRows = useMemo(() => {
    const slotsObj = week?.slots || {};
    return ALL_SLOTS.map((slot) => [slot, slotsObj[slot] || null]);
  }, [week]);

  const pendingUploadCount = Object.entries(savedRecipeIdsBySlot || {}).filter(
    ([slot, recipeId]) => recipeId && !uploadedRecipeIdsBySlot?.[slot]
  ).length;

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

  async function loadRecipe(recipeId) {
    if (!recipeId) {
      setRecipe(null);
      return;
    }
    const r = await fetchJson(`/api/recipes/${encodeURIComponent(recipeId)}`);
    setRecipe(r);
    setRecipeTitles((p) => ({ ...p, [recipeId]: r.title || recipeId }));
    setRecipeCache((p) => ({ ...p, [recipeId]: r }));
  }

  async function prefetchRecipe(recipeId) {
    if (!recipeId) return;
    const key = buildRecipePrefetchKey(recipeId);
    if (recipeCache?.[recipeId]) {
      setPrefetchStatus((prev) => ({ ...prev, [key]: "ready" }));
      clearTimeout(prefetchTimers.current[key]);
      prefetchTimers.current[key] = setTimeout(() => {
        setPrefetchStatus((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }, 1500);
      return;
    }
    setPrefetchStatus((prev) => ({ ...prev, [key]: "loading" }));
    if (recipePrefetchInFlight.current.has(recipeId)) return;
    recipePrefetchInFlight.current.add(recipeId);
    try {
      const r = await fetchJson(`/api/recipes/${encodeURIComponent(recipeId)}`);
      setRecipeTitles((p) => ({ ...p, [recipeId]: r.title || recipeId }));
      setRecipeCache((p) => ({ ...p, [recipeId]: r }));
      setPrefetchStatus((prev) => ({ ...prev, [key]: "ready" }));
    } catch {
      // ignore prefetch errors
    } finally {
      recipePrefetchInFlight.current.delete(recipeId);
      clearTimeout(prefetchTimers.current[key]);
      prefetchTimers.current[key] = setTimeout(() => {
        setPrefetchStatus((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }, 1500);
    }
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

  async function generateProposals(weekId) {
    try {
      if (!prepStart || !prepEnd) {
        alert("Merci de renseigner une date de début et une date de fin.");
        return;
      }
      const computedWeekId = buildWeekIdFromRange(prepStart, prepEnd);
      if (!computedWeekId) {
        alert("Impossible de calculer la référence de semaine.");
        return;
      }

      try {
        await fetchJson("/api/weeks/prepare", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            week_id: computedWeekId,
            date_start: prepStart,
            date_end: prepEnd
          })
        });
      } catch (e) {
        const msg = String(e?.message || "");
        if (!msg.includes("week_exists")) {
          alert(`Préparation impossible: ${msg}`);
          return;
        }
      }

      await loadWeeksList();
      await onChangeWeek(computedWeekId);

      await fetchJson("/api/chat/proposals/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          week_id: computedWeekId,
          slots: PROPOSAL_SLOTS,
          overwrite: true
        })
      });
      await loadMenuProposals(computedWeekId);
    } catch (e) {
      alert(`Propositions non generees: ${e.message}`);
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

      if (w?.date_start && w?.date_end) {
        setPrepStart(w.date_start);
        setPrepEnd(w.date_end);
        setPrepWeekId(buildWeekIdFromRange(w.date_start, w.date_end));
      }
    })();
  }, []);

  useEffect(() => {
    if (!selectedSlot || !week?.slots) return;
    const s = week.slots[selectedSlot] || null;
    if (s?.validated === true) loadRecipe(s?.recipe_id || null);
    else setRecipe(null);
  }, [selectedSlot, week]);

  useEffect(() => {
    if (!week?.slots) return;
    const next = {};
    for (const slot of FREE_TEXT_ALLOWED_SLOTS) {
      const saved = week.slots?.[slot]?.free_text;
      if (typeof saved === "string") next[slot] = saved;
    }
    setFreeTextBySlot(next);
  }, [week?.week_id]);

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

    if (w?.date_start && w?.date_end) {
      setPrepStart(w.date_start);
      setPrepEnd(w.date_end);
      setPrepWeekId(buildWeekIdFromRange(w.date_start, w.date_end));
    }
  }

  async function onPrepareWeek() {
    if (!prepStart || !prepEnd) {
      alert("Merci de renseigner une date de début et une date de fin.");
      return;
    }
    const computedWeekId = buildWeekIdFromRange(prepStart, prepEnd);
    if (!computedWeekId) {
      alert("Impossible de calculer la référence de semaine.");
      return;
    }
    try {
      await fetchJson("/api/weeks/prepare", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          week_id: computedWeekId,
          date_start: prepStart,
          date_end: prepEnd
        })
      });
    } catch (e) {
      const msg = String(e?.message || "");
      if (msg.includes("week_exists")) {
        alert("Semaine déjà existante — revoir les paramètres de création.");
        return;
      }
      alert(`Préparation impossible: ${msg}`);
      return;
    }
    await loadWeeksList();
    await onChangeWeek(computedWeekId);

    setPrepWeekId(computedWeekId);
  }

  async function onPeopleChange(slot, adults, children) {
    if (!week?.week_id) return;
    const child_birth_months =
      children > 0 ? Array(children).fill(DEFAULT_CHILD_BIRTH_MONTH) : [];

    await fetchJson(
      `/api/weeks/${encodeURIComponent(week.week_id)}/slots/${encodeURIComponent(slot)}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          people: { adults, children, child_birth_months }
        })
      }
    );

    const w = await loadWeek(week.week_id);
    setWeek(w);

    if (proposalModal?.slot === slot && proposalModal?.proposal) {
      const people = normalizePeopleFromSlot(w?.slots?.[slot]?.people);
      await loadProposalPreview(slot, proposalModal.proposal, people);
    }

    if (recipeModal?.slot === slot) {
      const slotData = w?.slots?.[slot] || {};
      if (slotData.free_text && !slotData.recipe_id) {
        await openRecipeModal(slot, w);
      }
    }
  }

  async function onValidateProposal(slot, proposal) {
    const recipeId = proposal?.recipe_id ? String(proposal.recipe_id) : "";
    const title = String(proposal?.title || "").trim();

    const payload = recipeId
      ? { recipe_id: recipeId, free_text: null }
      : { recipe_id: null, free_text: title };

    const j = await fetchJson(
      `/api/weeks/${encodeURIComponent(week.week_id)}/slots/${encodeURIComponent(
        slot
      )}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
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

  async function onDevalidateSlot(slot) {
    if (!week?.week_id) return;
    try {
      await fetchJson(
        `/api/weeks/${encodeURIComponent(week.week_id)}/slots/${encodeURIComponent(slot)}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ validated: false })
        }
      );
      const w = await loadWeek(week.week_id);
      setWeek(w);
      if (slot === selectedSlot) setRecipe(null);
      await loadMenuProposals(week.week_id);
    } catch (e) {
      alert(`Devalider failed: ${e.message}`);
    }
  }

  async function onOtherProposal(slot) {
    if (!week?.week_id) return;
    setProposalErrorBySlot((prev) => ({ ...prev, [slot]: null }));
    setProposalLoadingBySlot((prev) => ({ ...prev, [slot]: true }));
    try {
      const j = await fetchJson("/api/chat/proposals/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          week_id: week.week_id,
          slots: [slot],
          overwrite: true
        })
      });
      const next = j?.menu_proposals?.[slot];
      if (Array.isArray(next)) {
        setMenuProposals((prev) => ({ ...prev, [slot]: next }));
      } else {
        await loadMenuProposals(week.week_id);
      }
    } catch (e) {
      setProposalErrorBySlot((prev) => ({
        ...prev,
        [slot]: e.message || String(e)
      }));
    } finally {
      setProposalLoadingBySlot((prev) => ({ ...prev, [slot]: false }));
    }
  }

  async function onSaveValidatedSlot(slot) {
    const s = week?.slots?.[slot] || {};
    if (s.validated !== true) return;

    const rid = s.recipe_id || null;
    const title = String(
      s.free_text || (rid ? recipeTitles[rid] || rid : "")
    ).trim();

    if (!title) return;

    const people = normalizePeopleFromSlot(s?.people);

    try {
      let preview = null;
      if (rid) {
        const recipe = await fetchJson(`/api/recipes/${rid}`);
        preview = recipe?.content || null;
      } else {
        const j = await fetchJson("/api/chat/preview-title", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title, people })
        });
        preview = j?.preview || null;
      }
      if (!preview) {
        alert("Impossible de générer un aperçu de recette.");
        return;
      }

      const j = await fetchJson("/api/recipes/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title,
          week_id: week?.week_id,
          slot,
          source: { type: "MENU_VALIDATED" },
          people,
          preview
        })
      });
      if (j?.recipe_id) {
        setSavedRecipeIdsBySlot((prev) => ({ ...prev, [slot]: j.recipe_id }));
      }
    } catch (e) {
      alert(`Sauvegarder failed: ${e.message}`);
    }
  }

  async function onUploadWeek() {
    const entries = Object.entries(savedRecipeIdsBySlot || {});
    if (entries.length === 0) {
      alert("Aucune recette sauvegardée pour cette semaine.");
      return;
    }
    try {
      for (const [slot, recipe_id] of entries) {
        if (!recipe_id) continue;
        await fetchJson("/api/recipes/upload", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recipe_id })
        });
      }
      // All uploads succeeded: mark every saved slot as uploaded
      setUploadedRecipeIdsBySlot(
        Object.fromEntries(entries.map(([slot]) => [slot, true]))
      );
    } catch (e) {
      alert(`Upload failed: ${e.message}`);
    }
  }

  function validatedLabel(s) {
    if (!s || s.validated !== true) return "";
    if (s.recipe_id) {
      const rid = s.recipe_id;
      const title = recipeTitles[rid] || rid;
      const meta = recipeCache?.[rid];
      const isDrive = meta?.source?.type === "DRIVE";
      return isDrive ? `${title} (Drive)` : title;
    }
    if (s.free_text) return s.free_text;
    return "";
  }

  async function onFreeTextPersist(slot, value) {
    if (!week?.week_id) return;
    try {
      await fetchJson(
        `/api/weeks/${encodeURIComponent(week.week_id)}/slots/${encodeURIComponent(
          slot
        )}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            recipe_id: null,
            free_text: value || "",
            validated: false
          })
        }
      );
      const w = await loadWeek(week.week_id);
      setWeek(w);
    } catch (e) {
      alert(`Sauvegarde note failed: ${e.message}`);
    }
  }

  function getChildAges(child_birth_months) {
    const ref = week?.date_start
      ? new Date(week.date_start + "T00:00:00")
      : new Date();
    const refYear = ref.getFullYear();
    const refMonth = ref.getMonth() + 1;

    return (child_birth_months || [])
      .map((ym) => {
        const [y, m] = String(ym).split("-").map((n) => Number(n));
        if (!Number.isFinite(y) || !Number.isFinite(m)) return null;
        let age = refYear - y;
        if (refMonth < m) age -= 1;
        return age;
      })
      .filter((a) => Number.isFinite(a));
  }

  async function openProposalModal(slot, proposal) {
    setProposalModal({ slot, proposal });
    setProposalRecipe(null);
    setProposalError(null);

    const rid = proposal?.recipe_id || null;
    if (!rid) {
      const slotPeople = normalizePeopleFromSlot(week?.slots?.[slot]?.people);
      const signature = buildPeopleSignature(slotPeople);
      const key = buildProposalPreviewKey(proposal?.proposal_id, signature);
      const cachedPreview = previewCache?.[key];
      if (cachedPreview?.content) {
        setProposalRecipe({ content: cachedPreview.content });
        return;
      }
      await loadProposalPreview(slot, proposal, slotPeople);
      return;
    }

    setProposalLoading(true);
    try {
      const r = await fetchJson(`/api/recipes/${encodeURIComponent(rid)}`);
      setProposalRecipe(r);
    } catch (e) {
      setProposalError(e.message || String(e));
    } finally {
      setProposalLoading(false);
    }
  }

  async function loadProposalPreview(slot, proposal, peopleOverride = null) {
    if (!week?.week_id || !proposal?.proposal_id || !proposal?.title) return;
    const slotPeople =
      peopleOverride || normalizePeopleFromSlot(week?.slots?.[slot]?.people);
    const signature = buildPeopleSignature(slotPeople);
    const cacheKey = buildProposalPreviewKey(proposal.proposal_id, signature);
    const cachedPreview = previewCache?.[cacheKey];
    if (cachedPreview?.content) {
      setProposalRecipe({ content: cachedPreview.content });
      return;
    }

    setProposalLoading(true);
    setProposalError(null);
    try {
      const j = await fetchJson("/api/chat/proposals/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          week_id: week.week_id,
          slot,
          proposal_id: proposal.proposal_id,
          title: proposal.title,
          people: slotPeople
        })
      });
      setProposalRecipe({ content: j.preview });
      setPreviewCache((prev) => ({ ...prev, [cacheKey]: { content: j.preview } }));
    } catch (e) {
      setProposalError(e.message || String(e));
    } finally {
      setProposalLoading(false);
    }
  }

  async function prefetchProposalPreview(slot, proposal) {
    if (!proposal?.proposal_id || !proposal?.title) return;
    if (proposal.recipe_id) {
      await prefetchRecipe(proposal.recipe_id);
      return;
    }
    if (!week?.slots?.[slot]) return;
    const slotPeople = normalizePeopleFromSlot(week?.slots?.[slot]?.people);
    const signature = buildPeopleSignature(slotPeople);
    const cacheKey = buildProposalPreviewKey(proposal.proposal_id, signature);
    if (previewCache?.[cacheKey]?.content) {
      setPrefetchStatus((prev) => ({ ...prev, [cacheKey]: "ready" }));
      clearTimeout(prefetchTimers.current[cacheKey]);
      prefetchTimers.current[cacheKey] = setTimeout(() => {
        setPrefetchStatus((prev) => {
          const next = { ...prev };
          delete next[cacheKey];
          return next;
        });
      }, 1500);
      return;
    }
    setPrefetchStatus((prev) => ({ ...prev, [cacheKey]: "loading" }));
    if (previewPrefetchInFlight.current.has(cacheKey)) return;
    previewPrefetchInFlight.current.add(cacheKey);
    try {
      const j = await fetchJson("/api/chat/proposals/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          week_id: week.week_id,
          slot,
          proposal_id: proposal.proposal_id,
          title: proposal.title,
          people: slotPeople
        })
      });
      setPreviewCache((prev) => ({ ...prev, [cacheKey]: { content: j.preview } }));
      setPrefetchStatus((prev) => ({ ...prev, [cacheKey]: "ready" }));
    } catch {
      // ignore prefetch errors
    } finally {
      previewPrefetchInFlight.current.delete(cacheKey);
      clearTimeout(prefetchTimers.current[cacheKey]);
      prefetchTimers.current[cacheKey] = setTimeout(() => {
        setPrefetchStatus((prev) => {
          const next = { ...prev };
          delete next[cacheKey];
          return next;
        });
      }, 1500);
    }
  }

  async function prefetchFreeTextPreview(freeText, slotPeople) {
    if (!freeText) return;
    const signature = buildPeopleSignature(slotPeople);
    const cacheKey = buildFreeTextPrefetchKey(freeText, signature);
    if (previewCache?.[cacheKey]?.content) {
      setPrefetchStatus((prev) => ({ ...prev, [cacheKey]: "ready" }));
      clearTimeout(prefetchTimers.current[cacheKey]);
      prefetchTimers.current[cacheKey] = setTimeout(() => {
        setPrefetchStatus((prev) => {
          const next = { ...prev };
          delete next[cacheKey];
          return next;
        });
      }, 1500);
      return;
    }
    setPrefetchStatus((prev) => ({ ...prev, [cacheKey]: "loading" }));
    if (previewPrefetchInFlight.current.has(cacheKey)) return;
    previewPrefetchInFlight.current.add(cacheKey);
    try {
      const j = await fetchJson("/api/chat/preview-title", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: freeText,
          people: slotPeople
        })
      });
      setPreviewCache((prev) => ({ ...prev, [cacheKey]: { content: j.preview } }));
      setPrefetchStatus((prev) => ({ ...prev, [cacheKey]: "ready" }));
    } catch {
      // ignore prefetch errors
    } finally {
      previewPrefetchInFlight.current.delete(cacheKey);
      clearTimeout(prefetchTimers.current[cacheKey]);
      prefetchTimers.current[cacheKey] = setTimeout(() => {
        setPrefetchStatus((prev) => {
          const next = { ...prev };
          delete next[cacheKey];
          return next;
        });
      }, 1500);
    }
  }

  function closeProposalModal() {
    setProposalModal(null);
    setProposalRecipe(null);
    setProposalError(null);
    setProposalLoading(false);
  }

  async function openRecipeModal(slot, weekOverride = null) {
    setRecipeModal({ slot });
    setRecipeModalData(null);
    setRecipeModalError(null);
    setRecipeModalLoading(true);

    const slotData = weekOverride?.slots?.[slot] || week?.slots?.[slot] || {};
    const rid = slotData.recipe_id || null;
    const freeText = slotData.free_text || null;
    const slotPeople = normalizePeopleFromSlot(slotData.people);
    const signature = buildPeopleSignature(slotPeople);

    try {
      if (rid) {
        const cached = recipeCache[rid];
        if (cached) {
          setRecipeModalData(cached);
          setRecipeModalLoading(false);
          return;
        }

        setRecipeModalData({ title: recipeTitles[rid] || rid });
        const r = await fetchJson(`/api/recipes/${encodeURIComponent(rid)}`);
        setRecipeModalData(r);
        setRecipeCache((prev) => ({ ...prev, [rid]: r }));
        setRecipeModalLoading(false);
        return;
      }

      if (freeText) {
        const cacheKey = `${freeText}__${signature}`;
        const cachedPreview = previewCache[cacheKey];

        if (cachedPreview?.content) {
          setRecipeModalData({ title: freeText, content: cachedPreview.content });
          setRecipeModalLoading(false);
          return;
        }

        setRecipeModalData({ title: freeText });
        const j = await fetchJson("/api/chat/preview-title", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            title: freeText,
            people: slotPeople
          })
        });

        setRecipeModalData({ title: freeText, content: j.preview });
        setPreviewCache((prev) => ({
          ...prev,
          [cacheKey]: { content: j.preview }
        }));
        setRecipeModalLoading(false);
        return;
      }

      setRecipeModalError("Recette non disponible.");
    } catch (e) {
      setRecipeModalError(e.message || String(e));
    } finally {
      setRecipeModalLoading(false);
    }
  }

  function closeRecipeModal() {
    setRecipeModal(null);
    setRecipeModalData(null);
    setRecipeModalError(null);
    setRecipeModalLoading(false);
  }

  // --------------------
  // Render
  // --------------------
  return (
    <div style={{ display: "flex", gap: 16, padding: 16 }}>
      <aside
        style={{
          width: 260,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 18
        }}
      >
        <section>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Semaine</div>
          <select
            style={{ width: "100%" }}
            value={selectedWeekId}
            onChange={(e) => onChangeWeek(e.target.value)}
          >
            {weekIds.map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
        </section>

        <section>
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Nouvelle semaine</div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              type="text"
              placeholder="Week ID"
              value={prepWeekId}
              readOnly
            />
            <div style={{ fontSize: 12, opacity: 0.75 }}>Date de début</div>
            <input
              type="date"
              value={prepStart}
              onChange={(e) => {
                const picked = e.target.value;
                if (!picked) return;
                setPrepStart(picked);
                const end = addDays(picked, 6);
                setPrepEnd(end);
                setPrepWeekId(buildWeekIdFromRange(picked, end));
              }}
            />
            <div style={{ fontSize: 12, opacity: 0.75 }}>Date de fin</div>
            <input
              type="date"
              value={prepEnd}
              onChange={(e) => {
                const picked = e.target.value;
                if (!picked) return;
                setPrepEnd(picked);
                setPrepWeekId(buildWeekIdFromRange(prepStart, picked));
              }}
            />
            <div style={{ height: 32 }} />
          </div>
        </section>

        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button
            onClick={() => generateProposals(week?.week_id)}
            disabled={!week?.week_id}
          >
            Proposer menus
          </button>
        </section>

        <section style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <div style={{ fontWeight: 700 }}>Sauvegarder sur Drive</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <IconButton
              icon="☁️⬆️"
              label="Upload sur Drive"
              onClick={onUploadWeek}
              disabled={!week?.week_id}
            />
            {pendingUploadCount > 0 ? (
              <span style={{ fontSize: 12, opacity: 0.8 }}>
                {pendingUploadCount}
              </span>
            ) : null}
          </div>
        </section>
      </aside>

      <main style={{ flex: 1, minWidth: 0 }}>
        {week?.date_start && week?.date_end && (
          <h2 style={{ margin: "0 0 8px 0" }}>
            Semaine du {formatDateFr(week.date_start)} au {formatDateFr(week.date_end)}
          </h2>
        )}

        <table style={{ width: "100%", marginTop: 8, borderCollapse: "collapse" }}>
        <tbody>
          {tableRows.map(([slot, s]) => {
            const isSelected = selectedSlot === slot;
            const isValidated = s?.validated === true;
            const hasRecipe = Boolean(s?.recipe_id);

            const canFreeText =
              FREE_TEXT_ALLOWED_SLOTS.has(slot) && !isValidated && !hasRecipe;
            const showProposals = !isValidated;

                    const proposals = menuProposals?.[slot] || [];
                    const proposalLoading = !!proposalLoadingBySlot?.[slot];
                    const proposalError = proposalErrorBySlot?.[slot];
                    const people = normalizePeopleFromSlot(s?.people);
                    const totalPeople = peopleTotal(people);
                    const saved = !!savedRecipeIdsBySlot?.[slot];
                    const validatedRid = s?.recipe_id || null;
                    const validatedMeta = validatedRid ? recipeCache?.[validatedRid] : null;
                    const validatedIsDrive = validatedMeta?.source?.type === "DRIVE";

            return (
              <tr
                key={slot}
                onClick={() => setSelectedSlot(slot)}
                style={{
                  background: isSelected ? "#eef2ff" : "",
                  borderBottom: "1px solid #eee"
                }}
              >
                <td style={{ width: 220, verticalAlign: "top", padding: "10px 8px" }}>
                  {getSlotLabel(slot)}

                  <div style={{ marginTop: 6, fontSize: 12, opacity: 0.8 }}>
                    {totalPeople} pers.
                  </div>

                  <div
                    style={{ display: "flex", gap: 6, marginTop: 6 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <select
                      value={people.adults}
                      onChange={(e) =>
                        onPeopleChange(slot, Number(e.target.value), people.children)
                      }
                    >
                      {[1, 2, 3, 4].map((v) => (
                        <option key={`a-${slot}-${v}`} value={v}>
                          {v}A
                        </option>
                      ))}
                    </select>

                    <select
                      value={people.children}
                      onChange={(e) =>
                        onPeopleChange(slot, people.adults, Number(e.target.value))
                      }
                    >
                      {[0, 1, 2, 3].map((v) => (
                        <option key={`c-${slot}-${v}`} value={v}>
                          {v}E
                        </option>
                      ))}
                    </select>
                  </div>
                </td>

                <td style={{ verticalAlign: "top", padding: "10px 8px" }}>
                  {isValidated ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ fontWeight: 700 }}>
                        <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                          {validatedIsDrive ? <DriveIcon size={14} /> : null}
                          {validatedLabel(s)}
                        </span>
                        {totalPeople ? ` · ${totalPeople} pers.` : ""}
                      </div>
                      <IconButton
                        icon="👁️"
                        label="Voir"
                        onClick={(e) => {
                          e.stopPropagation();
                          openRecipeModal(slot);
                        }}
                        onMouseEnter={() => {
                          const rid = s?.recipe_id || null;
                          const freeText = s?.free_text || null;
                          const slotPeople = normalizePeopleFromSlot(s?.people);
                          if (rid) {
                            prefetchRecipe(rid);
                          } else if (freeText) {
                            prefetchFreeTextPreview(freeText, slotPeople);
                          }
                        }}
                        style={{ padding: "4px 6px" }}
                      />
                      {(() => {
                        const rid = s?.recipe_id || null;
                        const freeText = s?.free_text || null;
                        const signature = buildPeopleSignature(normalizePeopleFromSlot(s?.people));
                        const key = rid
                          ? buildRecipePrefetchKey(rid)
                          : freeText
                            ? buildFreeTextPrefetchKey(freeText, signature)
                            : null;
                        const status = key ? prefetchStatus?.[key] : null;
                        return status ? (
                          <span style={{ fontSize: 11, opacity: 0.75 }}>
                            {status === "loading" ? "Préchargement…" : "Préchargé"}
                          </span>
                        ) : null;
                      })()}
                      {(() => {
                        const rid = s?.recipe_id || null;
                        const meta = rid ? recipeCache?.[rid] : null;
                        const isDrive = meta?.source?.type === "DRIVE";
                        return !isDrive ? (
                          <IconButton
                            icon={saved ? "✅" : "💾"}
                            label="Sauvegarder"
                            onClick={(e) => {
                              e.stopPropagation();
                              onSaveValidatedSlot(slot);
                            }}
                            disabled={saved}
                            style={{ padding: "4px 6px" }}
                          />
                        ) : null;
                      })()}
                      {!saved && (
                        <IconButton
                          icon="❌"
                          label="Dévalider"
                          onClick={(e) => {
                            e.stopPropagation();
                            onDevalidateSlot(slot);
                          }}
                          style={{ padding: "4px 6px" }}
                        />
                      )}
                    </div>
                  ) : (
                    <>
                  {canFreeText && (
                    <textarea
                      style={{
                        display: "block",
                        width: "100%",
                        marginTop: 6,
                        padding: 6,
                        fontSize: 12
                      }}
                      rows={2}
                      value={freeTextBySlot[slot] ?? s?.free_text ?? ""}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) =>
                        setFreeTextBySlot((prev) => ({
                          ...prev,
                          [slot]: e.target.value
                        }))
                      }
                      onBlur={(e) => onFreeTextPersist(slot, e.target.value)}
                    />
                  )}

                      {showProposals &&
                        proposals.length > 0 && (
                          <div style={{ marginTop: 8, fontSize: 12, opacity: 0.8 }}>
                            Propositions
                          </div>
                        )}
                      {showProposals && proposalLoading && (
                        <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                          Génération en cours…
                        </div>
                      )}
                      {showProposals && proposalError && (
                        <div style={{ marginTop: 6, fontSize: 12, color: "#a00" }}>
                          Erreur: {proposalError}
                        </div>
                      )}
                      {showProposals &&
                        proposals.map((p) => {
                          return (
                            <div
                              key={p.proposal_id}
                              style={{
                                display: "flex",
                                gap: 8,
                                marginTop: 6,
                                alignItems: "center",
                                padding: "6px 8px",
                                border: "1px solid #eee",
                                borderRadius: 6,
                                background: "#fafafa"
                              }}
                              onClick={(e) => e.stopPropagation()}
                            >
                              <span style={{ flex: 1 }}>
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                  {p?.source === "DRIVE" ? <DriveIcon size={14} /> : null}
                                  {p.title}
                                </span>
                                {totalPeople ? ` · ${totalPeople} pers.` : ""}
                              </span>

                              <IconButton
                                icon="✅"
                                label="Valider pour la semaine"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onValidateProposal(slot, p);
                                }}
                                style={{ padding: "4px 6px" }}
                              />
                              <IconButton
                                icon="🔄"
                                label="Proposer"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onOtherProposal(slot);
                                }}
                                disabled={proposalLoading}
                                style={{ padding: "4px 6px" }}
                              />
                              <IconButton
                                icon="👁️"
                                label="Voir"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  openProposalModal(slot, p);
                                }}
                                onMouseEnter={(e) => {
                                  e.stopPropagation();
                                  prefetchProposalPreview(slot, p);
                                }}
                                style={{ padding: "4px 6px" }}
                              />
                              {(() => {
                                const signature = buildPeopleSignature(people);
                                const key = buildProposalPreviewKey(p.proposal_id, signature);
                                const status = prefetchStatus?.[key];
                                return status ? (
                                  <span style={{ fontSize: 11, opacity: 0.75 }}>
                                    {status === "loading" ? "Préchargement…" : "Préchargé"}
                                  </span>
                                ) : null;
                              })()}
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
      </main>

      {proposalModal && (
        <div
          onClick={closeProposalModal}
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
                Recette proposée — {getSlotLabel(proposalModal.slot)}
              </div>
              <button
                onClick={closeProposalModal}
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

            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 16, fontWeight: 700 }}>
                {proposalModal.proposal?.title || ""}
              </div>
              {proposalModal?.slot && (
                <div style={{ marginTop: 4, fontSize: 12, opacity: 0.75 }}>
                  {(() => {
                    const total = slotTotalPeople(week?.slots, proposalModal.slot);
                    return total ? `Pour ${total} personne(s)` : "";
                  })()}
                </div>
              )}

              {proposalLoading && (
                <div style={{ marginTop: 8, opacity: 0.8 }}>Chargement...</div>
              )}

              {proposalError && (
                <div style={{ marginTop: 8, color: "#a00" }}>
                  {proposalError}
                </div>
              )}

              {!proposalLoading && !proposalRecipe && !proposalError && (
                <div style={{ marginTop: 8, fontSize: 13, opacity: 0.8 }}>
                  Aperçu indisponible.
                </div>
              )}

              {proposalRecipe && (
                <div style={{ marginTop: 10 }}>
                  {proposalRecipe?.content?.description_courte && (
                    <div style={{ fontSize: 13, opacity: 0.9 }}>
                      {proposalRecipe.content.description_courte}
                    </div>
                  )}

                  {Array.isArray(proposalRecipe?.content?.ingredients) &&
                    proposalRecipe.content.ingredients.length > 0 && (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ fontWeight: 700, marginBottom: 4 }}>
                          Ingrédients
                        </div>
                        <ul style={{ margin: 0, paddingLeft: 18 }}>
                          {proposalRecipe.content.ingredients.map((ing, idx) => (
                            <li key={idx} style={{ fontSize: 13 }}>
                              {ing.qty} {ing.unit} {ing.item}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                  {Array.isArray(proposalRecipe?.content?.preparation_steps) &&
                    proposalRecipe.content.preparation_steps.length > 0 && (
                      <div style={{ marginTop: 10 }}>
                        <div style={{ fontWeight: 700, marginBottom: 4 }}>
                          Étapes
                        </div>
                        <ol style={{ margin: 0, paddingLeft: 18 }}>
                          {proposalRecipe.content.preparation_steps.map((step, idx) => (
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
        </div>
      )}

      {recipeModal && (
        <div
          onClick={closeRecipeModal}
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
                Recette validée — {getSlotLabel(recipeModal.slot)}
              </div>
              <button
                onClick={closeRecipeModal}
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

            {recipeModalLoading && (
              <div style={{ marginTop: 8, opacity: 0.8 }}>Chargement...</div>
            )}
            {recipeModalError && (
              <div style={{ marginTop: 8, color: "#a00" }}>
                {recipeModalError}
              </div>
            )}
            {recipeModalData && (
              <div style={{ marginTop: 10 }}>
                <div style={{ fontSize: 16, fontWeight: 700 }}>
                  {recipeModalData.title || recipeModalData.recipe_id}
                </div>
                {recipeModal?.slot && (
                  <div style={{ marginTop: 4, fontSize: 12, opacity: 0.75 }}>
                    {(() => {
                      const total = slotTotalPeople(week?.slots, recipeModal.slot);
                      return total ? `Pour ${total} personne(s)` : "";
                    })()}
                  </div>
                )}
                {recipeModalData?.content?.description_courte && (
                  <div style={{ fontSize: 13, opacity: 0.9 }}>
                    {recipeModalData.content.description_courte}
                  </div>
                )}
                {Array.isArray(recipeModalData?.content?.ingredients) &&
                  recipeModalData.content.ingredients.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>
                        Ingrédients
                      </div>
                      <ul style={{ margin: 0, paddingLeft: 18 }}>
                        {recipeModalData.content.ingredients.map((ing, idx) => (
                          <li key={idx} style={{ fontSize: 13 }}>
                            {ing.qty} {ing.unit} {ing.item}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                {Array.isArray(recipeModalData?.content?.preparation_steps) &&
                  recipeModalData.content.preparation_steps.length > 0 && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontWeight: 700, marginBottom: 4 }}>
                        Étapes
                      </div>
                      <ol style={{ margin: 0, paddingLeft: 18 }}>
                        {recipeModalData.content.preparation_steps.map((step, idx) => (
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
