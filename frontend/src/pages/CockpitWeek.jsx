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

function slotPrefixFromDate(dateObj) {
  const day = dateObj.getUTCDay();
  const map = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return map[day];
}

function activeSlotsFromRange(dateStart, dateEnd) {
  if (!dateStart || !dateEnd) return ALL_SLOTS;
  const out = [];
  const seen = new Set();
  const start = new Date(`${dateStart}T00:00:00Z`);
  const end = new Date(`${dateEnd}T00:00:00Z`);
  for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
    const prefix = slotPrefixFromDate(d);
    const lunch = `${prefix}_lunch`;
    const dinner = `${prefix}_dinner`;
    if (!seen.has(lunch)) {
      out.push(lunch);
      seen.add(lunch);
    }
    if (!seen.has(dinner)) {
      out.push(dinner);
      seen.add(dinner);
    }
  }
  return out;
}

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
      viewBox="0 0 48 48"
      aria-hidden="true"
      focusable="false"
      style={{ display: "inline-block", verticalAlign: "baseline" }}
    >
      <path fill="#0F9D58" d="M16.5 6 3 29.5l3 5.2L22.5 6z" />
      <path fill="#4285F4" d="M45 29.5 31.5 6 15 34.7l.3.6H41z" />
      <path fill="#F4B400" d="M16.5 6h15L45 29.5H30z" />
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

function maybeOpenOauth(message) {
  const prefix = "oauth_authorization_required:";
  const msg = String(message || "");
  if (!msg.startsWith(prefix)) return false;
  const url = msg.slice(prefix.length).trim();
  if (!url) return false;
  window.open(url, "_blank", "noopener");
  return true;
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

function buildWeekIdForDates(start, weekIds) {
  if (!start) return "";
  const [yearRaw] = start.split("-");
  const year = String(yearRaw || "").trim();
  if (!/^\d{4}$/.test(year)) return "";

  let max = 0;
  const re = new RegExp(`^${year}-W(\\d{2})$`);
  for (const id of weekIds || []) {
    const m = String(id).match(re);
    if (!m) continue;
    const n = Number(m[1]);
    if (Number.isFinite(n) && n > max) max = n;
  }

  const next = String(max + 1).padStart(2, "0");
  return `${year}-W${next}`;
}

function formatWeekRangeTitle(startStr, endStr) {
  if (!startStr || !endStr) return "";
  const start = new Date(`${startStr}T00:00:00`);
  const end = new Date(`${endStr}T00:00:00`);

  const startDay = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "2-digit"
  }).format(start);
  const endDay = new Intl.DateTimeFormat("fr-FR", {
    weekday: "long",
    day: "2-digit"
  }).format(end);

  const startMonth = new Intl.DateTimeFormat("fr-FR", { month: "long" }).format(start);
  const endMonth = new Intl.DateTimeFormat("fr-FR", { month: "long" }).format(end);
  const startYear = start.getFullYear();
  const endYear = end.getFullYear();

  if (startYear === endYear && start.getMonth() === end.getMonth()) {
    return `Semaine du ${startDay} au ${endDay} ${endMonth} ${endYear}`;
  }
  if (startYear === endYear) {
    return `Semaine du ${startDay} ${startMonth} au ${endDay} ${endMonth} ${endYear}`;
  }
  return `Semaine du ${startDay} ${startMonth} ${startYear} au ${endDay} ${endMonth} ${endYear}`;
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
  const [validatingBySlot, setValidatingBySlot] = useState({});
  const [uploadingWeek, setUploadingWeek] = useState(false);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [chatLoading, setChatLoading] = useState(false);
  const [shoppingOpen, setShoppingOpen] = useState(false);
  const [shoppingLoading, setShoppingLoading] = useState(false);
  const [shoppingError, setShoppingError] = useState(null);
  const [shoppingList, setShoppingList] = useState(null);
  const [pantryChecked, setPantryChecked] = useState({});
  const [pantryOrder, setPantryOrder] = useState({});
  const pantrySaveTimer = useRef(null);
  const [keepMode, setKeepMode] = useState("shopping");
  const [keepText, setKeepText] = useState("");
  const [dragOverSlot, setDragOverSlot] = useState(null);
  const dragFromSlotRef = useRef(null);

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
    const activeSlots =
      week?.rules_readonly?.active_slots && week.rules_readonly.active_slots.length
        ? week.rules_readonly.active_slots
        : activeSlotsFromRange(week?.date_start, week?.date_end);
    const ordered = activeSlots.filter((s) => ALL_SLOTS.includes(s));
    return ordered.map((slot) => [slot, slotsObj[slot] || null]);
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

  async function sendChatMessage() {
    if (!week?.week_id) return;
    const text = chatInput.trim();
    if (!text) return;
    const userMsg = { id: `u_${Date.now()}`, role: "user", text };
    setChatMessages((prev) => [...prev, userMsg]);
    setChatInput("");
    setChatLoading(true);
    try {
      const j = await fetchJson("/api/chat/commands/parse", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week_id: week.week_id, message: text })
      });
      const assistantMsg = {
        id: `a_${Date.now()}`,
        role: "assistant",
        text: j.summary || "Proposition prête.",
        action: j.action || null,
        rejectAction: j.reject_action || null,
        status: j.action ? "pending" : "info"
      };
      setChatMessages((prev) => [...prev, assistantMsg]);
    } catch (e) {
      setChatMessages((prev) => [
        ...prev,
        { id: `e_${Date.now()}`, role: "assistant", text: `Erreur: ${e.message}` }
      ]);
    } finally {
      setChatLoading(false);
    }
  }

  async function applyChatAction(messageId, action) {
    if (!week?.week_id || !action) return;
    try {
      const j = await fetchJson("/api/chat/commands/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week_id: week.week_id, action })
      });
      if (j?.week) {
        setWeek(j.week);
      }
      if (j?.menu_proposals) {
        setMenuProposals((prev) => ({ ...prev, ...j.menu_proposals }));
      }
      setChatMessages((prev) => {
        const next = prev.map((m) =>
          m.id === messageId ? { ...m, status: "applied", text: `${m.text} ✅` } : m
        );
        if (j?.followup_action) {
          next.push({
            id: `a_${Date.now()}_${Math.random().toString(16).slice(2)}`,
            role: "assistant",
            text: j.followup_summary || "Tu veux la recette ?",
            action: j.followup_action,
            rejectAction: j.followup_reject_action || null,
            status: "pending"
          });
        }
        return next;
      });
    } catch (e) {
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, status: "error", text: `${m.text} (Erreur: ${e.message})` }
            : m
        )
      );
    }
  }

  async function moveSlot(fromSlot, toSlot) {
    if (!week?.week_id) return;
    if (!fromSlot || !toSlot || fromSlot === toSlot) return;
    try {
      const j = await fetchJson("/api/chat/commands/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          week_id: week.week_id,
          action: { action_type: "move_slot", from_slot: fromSlot, to_slot: toSlot }
        })
      });
      if (j?.week) {
        setWeek(j.week);
      }
      if (j?.menu_proposals) {
        setMenuProposals((prev) => ({ ...prev, ...j.menu_proposals }));
      } else {
        await loadMenuProposals(week.week_id);
      }
    } catch (e) {
      alert(`Déplacement impossible: ${e.message}`);
    }
  }

  function beginDrag(slot, e) {
    dragFromSlotRef.current = slot;
    try {
      e.dataTransfer.setData("text/plain", slot);
      e.dataTransfer.effectAllowed = "move";
    } catch (_e) {}
  }

  function endDrag() {
    dragFromSlotRef.current = null;
    setDragOverSlot(null);
  }

  async function rejectChatAction(messageId) {
    const msg = chatMessages.find((m) => m.id === messageId);
    const rejectAction = msg?.rejectAction || null;
    if (!week?.week_id || !rejectAction) {
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, status: "rejected", text: `${m.text} ❌` } : m
        )
      );
      return;
    }

    try {
      const j = await fetchJson("/api/chat/commands/apply", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ week_id: week.week_id, action: rejectAction })
      });
      if (j?.week) {
        setWeek(j.week);
      }
      if (j?.menu_proposals) {
        setMenuProposals((prev) => ({ ...prev, ...j.menu_proposals }));
      }
      const isForceMenu =
        rejectAction?.action_type === "force_menu" ||
        rejectAction?.action_type === "force_menu_recipe";
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? {
                ...m,
                status: "applied",
                text: isForceMenu ? `${m.text} ✅ (sans recette)` : `${m.text} ❌`
              }
            : m
        )
      );
    } catch (e) {
      setChatMessages((prev) =>
        prev.map((m) =>
          m.id === messageId
            ? { ...m, status: "error", text: `${m.text} (Erreur: ${e.message})` }
            : m
        )
      );
    }
  }

  function clearChat() {
    setChatMessages([]);
    try {
      if (week?.week_id) {
        window.localStorage.removeItem(`mp_chat_${week.week_id}`);
      }
    } catch (_e) {}
  }

  async function openShoppingList(mode = "shopping") {
    if (!week?.week_id) return;
    setKeepMode(mode);
    setShoppingOpen(true);
    setShoppingLoading(true);
    setShoppingError(null);
    try {
      const j = await fetchJson(
        `/api/weeks/${encodeURIComponent(week.week_id)}/shopping-list`
      );
      setShoppingList(j);
      // Prefetch validated recipes so Keep export has content.
      const slots = j?.week?.slots || {};
      const isSlotValidated = (slot) =>
        slot?.validated === true ||
        (slot?.validated == null && (slot?.recipe_id || slot?.free_text));
      const recipeIds = Array.from(
        new Set(
          Object.values(slots)
            .filter(isSlotValidated)
            .filter((s) => s?.recipe_id)
            .map((s) => s.recipe_id)
        )
      );
      for (const rid of recipeIds) {
        await loadRecipe(rid);
      }
      if (mode === "menus") {
        setKeepText(buildKeepMenuText(j));
      } else if (mode === "recipes") {
        setKeepText(buildKeepRecipesText(j));
      } else {
        const consolidated = consolidateShoppingItems(j.items || []);
        setKeepText(buildKeepShoppingText({ ...j, items: consolidated }));
      }
      const next = {};
      const consolidated = consolidateShoppingItems(j.items || []);
      consolidated.forEach((it) => {
        const key = `${it.item}__${it.unit || ""}`;
        next[key] = false;
      });
      const persisted = j?.week?.pantry_checked || {};
      const merged = { ...next, ...persisted };
      setPantryChecked(merged);
      setPantryOrder({});
    } catch (e) {
      setShoppingError(e.message || String(e));
    } finally {
      setShoppingLoading(false);
    }
  }

  useEffect(() => {
    if (!shoppingOpen || keepMode !== "shopping" || !shoppingList) return;
    const consolidated = consolidateShoppingItems(shoppingList.items || []);
    const filtered = consolidated.filter((it) => {
      const key = `${it.item}__${it.unit || ""}`;
      return !pantryChecked[key];
    });
    const listData = { ...shoppingList, items: filtered };
    setKeepText(buildKeepShoppingText(listData));
  }, [pantryChecked, keepMode, shoppingList, shoppingOpen]);

  useEffect(() => {
    if (!shoppingOpen || keepMode !== "recipes" || !shoppingList) return;
    setKeepText(buildKeepRecipesText(shoppingList));
  }, [shoppingOpen, keepMode, shoppingList, recipeCache]);

  useEffect(() => {
    if (!shoppingOpen || keepMode !== "shopping" || !week?.week_id) return;
    clearTimeout(pantrySaveTimer.current);
    pantrySaveTimer.current = setTimeout(async () => {
      try {
        await fetchJson(
          `/api/weeks/${encodeURIComponent(week.week_id)}/pantry`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ pantry_checked: pantryChecked })
          }
        );
      } catch {
        // silent fail; local state still works
      }
    }, 600);
    return () => clearTimeout(pantrySaveTimer.current);
  }, [pantryChecked, shoppingOpen, keepMode, week?.week_id]);

  function toAscii(text) {
    return String(text || "")
      .replace(/œ/g, "oe")
      .replace(/Œ/g, "OE")
      .replace(/æ/g, "ae")
      .replace(/Æ/g, "AE")
      .replace(/[’‘]/g, "'")
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^\x00-\x7F]/g, "");
  }

  function buildKeepMenuText(listData) {
    if (!listData?.week?.date_start || !listData?.week?.date_end) return "";
    const title = `MENU LIST (${listData.week.week_id})`;
    const lines = [title, ""];
    const slotPrefixFromDate = (dateObj) => {
      const day = dateObj.getUTCDay();
      const map = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
      return map[day];
    };
    const labelMap = {
      mon_lunch: "Monday Lunch",
      mon_dinner: "Monday Dinner",
      tue_lunch: "Tuesday Lunch",
      tue_dinner: "Tuesday Dinner",
      wed_lunch: "Wednesday Lunch",
      wed_dinner: "Wednesday Dinner",
      thu_lunch: "Thursday Lunch",
      thu_dinner: "Thursday Dinner",
      fri_lunch: "Friday Lunch",
      fri_dinner: "Friday Dinner",
      sat_lunch: "Saturday Lunch",
      sat_dinner: "Saturday Dinner",
      sun_lunch: "Sunday Lunch",
      sun_dinner: "Sunday Dinner"
    };
    const slots = listData.week.slots || {};
    const start = new Date(`${listData.week.date_start}T00:00:00Z`);
    const end = new Date(`${listData.week.date_end}T00:00:00Z`);
    for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
      const prefix = slotPrefixFromDate(d);
      const daySlots = [`${prefix}_lunch`, `${prefix}_dinner`];
      for (const slot of daySlots) {
        const s = slots[slot] || {};
        const titleRaw = s.free_text || s.recipe_id || "";
        const title = titleRaw ? titleRaw : "XXXX";
        lines.push(`${labelMap[slot]}: ${title}`);
      }
    }
    return toAscii(lines.join("\n"));
  }

  function buildKeepShoppingText(listData) {
    const weekId = listData?.week?.week_id || "Semaine";
    const lines = [`LISTE DE COURSES - ${weekId}`, ""];
    lines.push("INGREDIENT | QUANTITE A ACHETER | RECETTES CONCERNEES");
    lines.push("");
    const items = listData?.items || [];
    const grouped = {};
    items.forEach((it) => {
      const name = toAscii(it.item || "");
      if (!grouped["GENERAL"]) grouped["GENERAL"] = [];
      grouped["GENERAL"].push({
        item: name,
        qty: toAscii(it.qty || ""),
        unit: toAscii(it.unit || ""),
        recipes: toAscii((it.recipes || []).join(", "))
      });
    });
    Object.keys(grouped).forEach((cat) => {
      lines.push(cat);
      grouped[cat].forEach((it) => {
        const qty = [it.qty, it.unit].filter(Boolean).join(" ").trim();
        const recipes = it.recipes || "";
        lines.push(`- ${it.item} | ${qty} | ${recipes}`);
      });
      lines.push("");
    });
    return toAscii(lines.join("\n")).trim();
  }

  function consolidateShoppingItems(items = []) {
    const map = new Map();
    const normalizeUnitKey = (unitRaw) => {
      const u = toAscii(unitRaw || "")
        .toLowerCase()
        .replace(/\(s\)/g, "s")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
      if (!u) return "";
      const compact = u.replace(/\s+/g, " ");
      if (["c a cafe", "c a c", "cafe", "cc"].includes(compact)) return "cafe";
      if (["c a soupe", "c a s", "soupe", "cs"].includes(compact)) return "soupe";
      if (["piece", "pieces", "pc", "pcs"].includes(compact)) return "piece";
      if (["gousse", "gousses"].includes(compact)) return "gousse";
      if (["pincee", "pincees"].includes(compact)) return "pincee";
      if (["gramme", "grammes", "gr", "g"].includes(compact)) return "g";
      if (["kilogramme", "kilogrammes", "kg"].includes(compact)) return "kg";
      if (["millilitre", "millilitres", "ml"].includes(compact)) return "ml";
      if (["centilitre", "centilitres", "cl"].includes(compact)) return "cl";
      if (["litre", "litres", "l"].includes(compact)) return "l";
      return compact;
    };
    const extractQtyUnit = (itemRaw, unitRaw, qtyRaw) => {
      const raw = String(itemRaw || "");
      if (unitRaw || qtyRaw) return { item: raw, unit: unitRaw, qty: qtyRaw };
      const rawAscii = toAscii(raw);
      const m = rawAscii.match(
        /^\s*(\d+(?:[.,]\d+)?)\s*(c\.?\s*a\.?\s*c\.?|c\.?\s*a\.?\s*s\.?|c\.?\s*a\.?\s*caf[eé]?|c\.?\s*a\.?\s*soupe|cc|cs|gousses?|gousse\(s\)?|pinc[eé]e\(s\)?|pinc[eé]es?|pi[eè]ce\(s\)?|pieces?|pc|pcs|g|gr|kg|ml|cl|l)\s+(.*)$/i
      );
      if (!m) return { item: itemRaw, unit: unitRaw, qty: qtyRaw };
      return {
        qty: m[1],
        unit: m[2],
        item: m[3]
      };
    };
    const normalizeItemKey = (itemRaw) =>
      toAscii(itemRaw || "")
        .toLowerCase()
        .replace(/\(.*?\)/g, " ")
        .replace(/\b(optionnel|facultatif|au gout|gout)\b/g, " ")
        .replace(/\b(rouge|vert|jaune|speciale|speciales|type|egoutte|egouttes|rince|rincees|cuit|cuite|cuits|cuites|surgele|surgeles)\b/g, " ")
        .replace(/\ben poudre\b/g, " ")
        .replace(/^\s*\d+(?:[.,]\d+)?\s*(gousse\(s\)?|gousses?|pi[eè]ce\(s\)?|pieces?|pc|pcs|pinc[eé]e\(s\)?|pinc[eé]es?|c\.?\s*a\.?\s*c\.?|c\.?\s*a\.?\s*s\.?|cafe|soupe)?\s+/i, "")
        .replace(/[,.;:]+/g, " ")
        .replace(/[^a-z0-9]+/g, " ")
        .trim();
    const canonicalItem = (itemRaw) => {
      let base = normalizeItemKey(itemRaw);
      if (!base) return { key: "", label: itemRaw };
      const withoutPlural = base.replace(/\b(\w+)s\b/g, "$1");
      base = withoutPlural;
      // normalize common pairs
      if (base.includes("piment") && base.includes("poudre")) {
        base = base.replace(/\bpoudre\b/g, "").trim();
      }
      if (base.includes("poivron")) {
        base = base.replace(/\brouge\b|\bvert\b|\bjaune\b/g, "").trim();
      }
      if (base.startsWith("pommes ") && base.includes("de terre")) {
        base = "pommes de terre";
      }
      const synonyms = {
        "cumin": "cumin moulu",
        "cumin moulu": "cumin moulu",
        "poivre": "poivre",
        "sel": "sel",
        "ail": "ail",
        "oignon": "oignon",
        "poireau": "poireau",
        "poivron": "poivron"
      };
      const key = synonyms[base] || base;
      const label = synonyms[base] || itemRaw;
      return { key, label };
    };
    const spiceSet = new Set([
      "sel",
      "poivre",
      "cumin moulu",
      "cumin",
      "piment",
      "paprika",
      "thym",
      "herbes de provence"
    ]);
    const produceUnitFallback = {
      ail: "gousse",
      oignon: "piece",
      poireau: "piece",
      poivron: "piece"
    };
    items.forEach((it) => {
      let itemRaw = String(it?.item || "").trim();
      if (!itemRaw) return;
      let unitRaw = String(it?.unit || "").trim();
      let qtyRaw = String(it?.qty || "").trim();
      const extracted = extractQtyUnit(itemRaw, unitRaw, qtyRaw);
      itemRaw = String(extracted.item || "").trim() || itemRaw;
      unitRaw = String(extracted.unit || "").trim() || unitRaw;
      qtyRaw = String(extracted.qty || "").trim() || qtyRaw;
      const canon = canonicalItem(itemRaw);
      const isSpice = spiceSet.has(canon.key);
      let unitKey = isSpice ? "spice" : normalizeUnitKey(unitRaw);
      if (!unitKey && produceUnitFallback[canon.key]) {
        unitKey = produceUnitFallback[canon.key];
      }
      const key = `${canon.key}__${unitKey}`;
      if (!map.has(key)) {
        map.set(key, {
          item: canon.label || itemRaw,
          unit: spiceSet.has(canon.key)
            ? ""
            : unitRaw || (produceUnitFallback[canon.key] || ""),
          qtys: [],
          recipes: new Set(),
          spiceTsp: 0
        });
      }
      const entry = map.get(key);
      if ((canon.label || itemRaw).length > String(entry.item || "").length) {
        entry.item = canon.label || itemRaw;
      }
      if (qtyRaw) {
        if (isSpice) {
          const unitNorm = normalizeUnitKey(unitRaw);
          const qtyNorm = qtyRaw.replace(",", ".");
          const num = /^\d+(\.\d+)?$/.test(qtyNorm) ? Number(qtyNorm) : null;
          if (num != null) {
            const tsp =
              unitNorm === "cafe"
                ? num
                : unitNorm === "soupe"
                  ? num * 3
                  : unitNorm === "pincee"
                    ? num * 0.125
                    : null;
            if (tsp != null) {
              entry.spiceTsp += tsp;
            } else {
              entry.qtys.push(`${qtyRaw}${unitRaw ? ` ${unitRaw}` : ""}`.trim());
            }
          } else {
            entry.qtys.push(`${qtyRaw}${unitRaw ? ` ${unitRaw}` : ""}`.trim());
          }
        } else {
          entry.qtys.push(qtyRaw);
        }
      }
      (it?.recipes || []).forEach((r) => entry.recipes.add(r));
    });
    const out = [];
    map.forEach((entry) => {
      let qty = "";
      if (entry.spiceTsp && entry.spiceTsp > 0) {
        const tsp = Math.round(entry.spiceTsp * 10) / 10;
        qty = `${tsp} c. a cafe`;
        if (entry.qtys.length > 0) {
          qty += ` + ${Array.from(new Set(entry.qtys)).join(" + ")}`;
        }
      } else {
        const qtyNums = entry.qtys
          .map((q) => q.replace(",", "."))
          .map((q) => (/^\d+(\.\d+)?$/.test(q) ? Number(q) : null))
          .filter((v) => v != null);
        if (qtyNums.length === entry.qtys.length && qtyNums.length > 0) {
          qty = String(qtyNums.reduce((a, b) => a + b, 0));
        } else if (entry.qtys.length > 0) {
          qty = Array.from(new Set(entry.qtys)).join(" + ");
        }
      }
      out.push({
        item: entry.item,
        unit: entry.unit,
        qty,
        recipes: Array.from(entry.recipes)
      });
    });
    out.sort((a, b) => a.item.localeCompare(b.item));
    return out;
  }

  function buildKeepRecipesText(listData) {
    const weekId = listData?.week?.week_id || "Semaine";
    const lines = [`RECETTES - ${weekId}`, ""];
    const slots = listData?.week?.slots || {};
    const dateStart = listData?.week?.date_start;
    const dateEnd = listData?.week?.date_end;
    const slotOrder = activeSlotsFromRange(dateStart, dateEnd);
    const isSlotValidated = (slot) =>
      slot?.validated === true ||
      (slot?.validated == null && (slot?.recipe_id || slot?.free_text));
    const slotDateLabel = {};
    if (dateStart && dateEnd) {
      const start = new Date(`${dateStart}T00:00:00Z`);
      const end = new Date(`${dateEnd}T00:00:00Z`);
      for (let d = new Date(start); d <= end; d = new Date(d.getTime() + 86400000)) {
        const prefix = slotPrefixFromDate(d);
        const label = new Intl.DateTimeFormat("fr-FR", {
          weekday: "long",
          day: "numeric",
          month: "long"
        }).format(d);
        slotDateLabel[`${prefix}_lunch`] = label;
        slotDateLabel[`${prefix}_dinner`] = label;
      }
    }
    const ordered = slotOrder
      .map((slotKey) => ({ slotKey, slot: slots?.[slotKey] }))
      .filter(({ slot }) => isSlotValidated(slot));
    if (!ordered.length) {
      lines.push("AUCUNE RECETTE VALIDEE");
      return toAscii(lines.join("\n"));
    }
    ordered.forEach((entry, idx) => {
      const slotKey = entry.slotKey;
      const slot = entry.slot || {};
      const slotLabel = getSlotLabel(slotKey);
      const dateLabel = slotDateLabel[slotKey];
      const header = dateLabel ? `${slotLabel} (${dateLabel})` : slotLabel;
      lines.push(toAscii(header));
      lines.push("");
      const generated = slot?.generated_recipe || slot?.preview || null;
      if (slot?.free_text && !slot?.recipe_id && !generated) {
        lines.push(toAscii(slot.free_text));
        if (idx < ordered.length - 1) lines.push("", "-----", "");
        return;
      }
      const recipe = slot?.recipe_id ? recipeCache?.[slot.recipe_id] : null;
      const content = recipe?.content || generated || {};
      const title = toAscii(
        recipe?.title || slot.recipe_id || slot.free_text || ""
      );
      if (title) lines.push(title);
      lines.push("");
      const desc = toAscii(content?.description_courte || "");
      if (desc) lines.push(desc);
      if (desc) lines.push("");
      const ingredients = Array.isArray(content?.ingredients)
        ? content.ingredients
        : [];
      if (ingredients.length) {
        lines.push("INGREDIENTS");
        ingredients.forEach((ing) => {
          const qty = toAscii(ing?.qty || "");
          const unit = toAscii(ing?.unit || "");
          const item = toAscii(ing?.item || "");
          const q = [qty, unit].filter(Boolean).join(" ").trim();
          lines.push(`- ${q ? `${q} ` : ""}${item}`.trim());
        });
        lines.push("");
      }
      const steps = Array.isArray(content?.preparation_steps)
        ? content.preparation_steps
        : [];
      if (steps.length) {
        lines.push("ETAPES");
        steps.forEach((step, sidx) => {
          lines.push(`${sidx + 1}. ${toAscii(step)}`);
        });
      }
      if (idx < ordered.length - 1) lines.push("", "-----", "");
    });
    return toAscii(lines.join("\n"));
  }

  async function generateProposals(weekId) {
    try {
      if (!prepStart || !prepEnd) {
        alert("Merci de renseigner une date de début et une date de fin.");
        return;
      }
      let computedWeekId = buildWeekIdForDates(prepStart, weekIds);
      if (!computedWeekId) {
        alert("Impossible de calculer la référence de semaine.");
        return;
      }

      try {
        const existing = await fetchJson(
          `/api/weeks/by-dates?date_start=${encodeURIComponent(
            prepStart
          )}&date_end=${encodeURIComponent(prepEnd)}`
        );
        if (existing?.week_id) {
          computedWeekId = existing.week_id;
        }
      } catch (e) {
        // ignore if not found
      }

      if (!weekIds.includes(computedWeekId)) {
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
      }

      await loadWeeksList();
      const currentWeek = await onChangeWeek(computedWeekId);
      const weekSlots = currentWeek?.slots || {};
      const activeSlots =
        currentWeek?.rules_readonly?.active_slots && currentWeek.rules_readonly.active_slots.length
          ? currentWeek.rules_readonly.active_slots
          : activeSlotsFromRange(currentWeek?.date_start, currentWeek?.date_end);
      const slotsToGenerate = PROPOSAL_SLOTS.filter(
        (slot) => activeSlots.includes(slot) && !(weekSlots[slot]?.validated === true)
      );
      if (slotsToGenerate.length === 0) {
        alert("Toutes les propositions sont déjà validées.");
        return;
      }

      await fetchJson("/api/chat/proposals/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          week_id: computedWeekId,
          slots: slotsToGenerate,
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

      const activeSlots =
        w?.rules_readonly?.active_slots && w.rules_readonly.active_slots.length
          ? w.rules_readonly.active_slots
          : activeSlotsFromRange(w?.date_start, w?.date_end);
      const first =
        activeSlots.find((k) => (w?.slots?.[k]?.validated === true)) ||
        activeSlots.find((k) => w?.slots?.[k]?.recipe_id) ||
        activeSlots[0] ||
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
        setPrepWeekId(w.week_id || "");
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

  useEffect(() => {
    if (!week?.week_id) return;
    try {
      const raw = window.localStorage.getItem(`mp_chat_${week.week_id}`);
      if (!raw) return;
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        setChatMessages(parsed);
      }
    } catch (_e) {}
  }, [week?.week_id]);

  useEffect(() => {
    if (!week?.week_id) return;
    try {
      window.localStorage.setItem(`mp_chat_${week.week_id}`, JSON.stringify(chatMessages));
    } catch (_e) {}
  }, [chatMessages, week?.week_id]);

  // --------------------
  // Actions
  // --------------------
  async function onInitWeek() {
    await generateProposals();
  }

  async function onChangeWeek(id) {
    const w = await loadWeek(id);

    const activeSlots =
      w?.rules_readonly?.active_slots && w.rules_readonly.active_slots.length
        ? w.rules_readonly.active_slots
        : activeSlotsFromRange(w?.date_start, w?.date_end);
    const first =
      activeSlots.find((k) => (w?.slots?.[k]?.validated === true)) ||
      activeSlots.find((k) => w?.slots?.[k]?.recipe_id) ||
      activeSlots[0] ||
      "mon_dinner";

    setSelectedSlot(first);
    await loadMenuProposals(w.week_id);

    if (w?.date_start && w?.date_end) {
      setPrepStart(w.date_start);
      setPrepEnd(w.date_end);
      setPrepWeekId(w.week_id || "");
    }
    return w;
  }

  async function onPrepareWeek() {
    if (!prepStart || !prepEnd) {
      alert("Merci de renseigner une date de début et une date de fin.");
      return null;
    }
    const computedWeekId = buildWeekIdForDates(prepStart, weekIds);
    if (!computedWeekId) {
      alert("Impossible de calculer la référence de semaine.");
      return null;
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
        return null;
      }
      if (msg.includes("week_overlap")) {
        alert(`Recouvrement de dates détecté — ${msg}`);
        return null;
      }
      alert(`Préparation impossible: ${msg}`);
      return null;
    }
    await loadWeeksList();
    await onChangeWeek(computedWeekId);

    setPrepWeekId(computedWeekId);
    return computedWeekId;
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
    if (validatingBySlot?.[slot]) return;
    setValidatingBySlot((prev) => ({ ...prev, [slot]: true }));
    const recipeId = proposal?.recipe_id ? String(proposal.recipe_id) : "";
    const title = String(proposal?.title || "").trim();
    const sourceType = proposal?.source ? String(proposal.source) : null;

    const payload = recipeId
      ? { recipe_id: recipeId, free_text: null }
      : { recipe_id: null, free_text: title };

    try {
      const j = await fetchJson(
        `/api/weeks/${encodeURIComponent(week.week_id)}/slots/${encodeURIComponent(
          slot
        )}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...payload,
            source_type: sourceType
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
    } catch (e) {
      alert(`Valider failed: ${e.message}`);
    } finally {
      setValidatingBySlot((prev) => ({ ...prev, [slot]: false }));
    }
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

  async function onReproposeValidated(slot) {
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
      await onOtherProposal(slot);
    } catch (e) {
      alert(`Reproposer failed: ${e.message}`);
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
      setUploadingWeek(true);
      const errors = [];
      let okCount = 0;
      for (const [slot, recipe_id] of entries) {
        if (!recipe_id || uploadedRecipeIdsBySlot?.[slot]) continue;
        try {
          await fetchJson("/api/recipes/upload", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ recipe_id })
          });
          okCount += 1;
          setUploadedRecipeIdsBySlot((prev) => ({ ...prev, [slot]: true }));
        } catch (e) {
          const msg = e.message || String(e);
          if (maybeOpenOauth(msg)) {
            errors.push({
              slot,
              error: "Autorisation Google requise. Fenêtre ouverte."
            });
            continue;
          }
          errors.push({ slot, error: msg });
        }
      }
      if (errors.length) {
        const sample = errors.slice(0, 3).map((e) => `${e.slot}: ${e.error}`).join("\n");
        alert(`Upload terminé avec erreurs (${okCount} ok, ${errors.length} erreur(s)):\n${sample}`);
      } else {
        alert(`Upload terminé (${okCount} recette(s)). Pense à lancer un rescan.`);
      }
    } catch (e) {
      const msg = e.message || String(e);
      if (maybeOpenOauth(msg)) {
        alert("Autorisation Google requise. Une fenêtre s'est ouverte.");
      } else {
        alert(`Upload failed: ${msg}`);
      }
    } finally {
      setUploadingWeek(false);
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

        if (slotData?.generated_recipe) {
          setRecipeModalData({ title: freeText, content: slotData.generated_recipe });
          setPreviewCache((prev) => ({
            ...prev,
            [cacheKey]: { content: slotData.generated_recipe }
          }));
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
  const isMenuMode = keepMode === "menus";
  const menuLineCount = isMenuMode && keepText ? keepText.split("\n").length : 0;
  const menuRows = isMenuMode ? Math.min(36, Math.max(6, menuLineCount)) : undefined;

  return (
    <div className="page week-layout" style={{ display: "flex", gap: 16 }}>
      <aside
        className="week-sidebar week-sidebar-left"
        style={{
          width: 260,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 10
        }}
      >
        <section className="panel">
          <div className="panel-title" style={{ marginBottom: 10 }}>
            1 · Choisir une semaine
          </div>
          <select
            style={{ width: "100%" }}
            value={selectedWeekId}
            onChange={(e) => onChangeWeek(e.target.value)}
          >
            {weekIds.map((id) => (
              <option key={id}>{id}</option>
            ))}
          </select>
          {selectedWeekId ? (
            <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
              Semaine active: {selectedWeekId}
            </div>
          ) : null}
        </section>

        <section className="panel">
          <div className="panel-title" style={{ marginBottom: 10 }}>
            2 · Créer une nouvelle semaine
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <input
              type="text"
              placeholder="Week ID"
              value={prepWeekId}
              readOnly
            />
            <div style={{ fontSize: 14, opacity: 0.75 }}>Date de début</div>
            <input
              type="date"
              value={prepStart}
              onChange={(e) => {
                const picked = e.target.value;
                if (!picked) return;
                setPrepStart(picked);
                const end = addDays(picked, 6);
                setPrepEnd(end);
                setPrepWeekId(buildWeekIdForDates(picked, weekIds));
              }}
            />
            <div style={{ fontSize: 14, opacity: 0.75 }}>Date de fin</div>
            <input
              type="date"
              value={prepEnd}
              onChange={(e) => {
                const picked = e.target.value;
                if (!picked) return;
                setPrepEnd(picked);
                setPrepWeekId(buildWeekIdForDates(prepStart, weekIds));
              }}
            />
            <div style={{ height: 4 }} />
            <button
              onClick={onInitWeek}
              disabled={!prepStart || !prepEnd}
              className="btn-side"
              style={{ fontSize: 13, padding: "3px 6px", alignSelf: "flex-start" }}
            >
              Initier
            </button>
          </div>
        </section>

        <section className="panel">
          <div className="panel-title" style={{ marginBottom: 10 }}>
            3 · Proposer les menus
          </div>
          <button
            onClick={() => generateProposals(week?.week_id)}
            disabled={!week?.week_id}
            className="btn-side"
            style={{ fontSize: 13, padding: "3px 6px" }}
          >
            Nouveaux menus
          </button>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
            Les recettes non validées seront remplacées.
          </div>
        </section>

        <section className="panel" style={{ padding: 10 }}>
          <div className="panel-title" style={{ marginBottom: 6 }}>
            4 · Upload
          </div>
          <div
            onClick={onUploadWeek}
            style={{
              fontSize: 12,
              opacity: 0.9,
              marginTop: 4,
              display: "flex",
              alignItems: "center",
              gap: 8,
              cursor: week?.week_id && !uploadingWeek ? "pointer" : "default",
              userSelect: "none"
            }}
          >
            <span>Upload to Drive/Recettes</span>
            <span style={{ fontSize: 16 }}>☁️⬆️</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            {pendingUploadCount > 0 ? (
              <span style={{ fontSize: 12, opacity: 0.8 }}>
                {pendingUploadCount}
              </span>
            ) : null}
          </div>
        </section>

        <section className="panel">
          <div className="panel-title" style={{ marginBottom: 10 }}>
            5 · Listes
          </div>
          <div style={{ fontSize: 12, opacity: 0.7, marginTop: 8 }}>
            Exports Keep-safe (menus, recettes, courses).
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8 }}>
            <button
              onClick={() => openShoppingList("menus")}
              disabled={!week?.week_id}
              className="btn-side"
              style={{ fontSize: 13, padding: "3px 6px" }}
            >
              Menus
            </button>
            <button
              onClick={() => openShoppingList("recipes")}
              disabled={!week?.week_id}
              className="btn-side"
              style={{ fontSize: 13, padding: "3px 6px" }}
            >
              Recettes
            </button>
            <button
              onClick={() => openShoppingList("shopping")}
              disabled={!week?.week_id}
              className="btn-side"
              style={{ fontSize: 13, padding: "3px 6px" }}
            >
              Courses
            </button>
          </div>
        </section>
      </aside>

      <div className="divider-vertical" aria-hidden="true" />
      <main className="week-main" style={{ flex: 1, minWidth: 0 }}>
        {week?.date_start && week?.date_end && (
          <h2 className="toolbar-title" style={{ margin: "0 0 8px 0" }}>
            {formatWeekRangeTitle(week.date_start, week.date_end)}
          </h2>
        )}

        <table className="week-table" style={{ width: "100%", marginTop: 8, borderCollapse: "collapse" }}>
        <tbody>
          {tableRows.map(([slot, s]) => {
            const isSelected = selectedSlot === slot;
            const isValidated = s?.validated === true;
            const hasRecipe = Boolean(s?.recipe_id);
            const hasGeneratedRecipe = Boolean(
              s?.generated_recipe &&
                (Array.isArray(s?.generated_recipe?.ingredients) ||
                  s?.generated_recipe?.description_courte)
            );
            const canDrag =
              isValidated &&
              (s?.recipe_id || (s?.free_text && String(s?.free_text || "").trim()));
            const isFreeTextForced = Boolean(
              s?.free_text &&
                !s?.recipe_id &&
                (!s?.source_type ||
                  s?.source_type === "CHAT_USER" ||
                  s?.source_type === "USER" ||
                  s?.source_type === "MANUAL") &&
                !hasGeneratedRecipe
            );

            const canFreeText =
              FREE_TEXT_ALLOWED_SLOTS.has(slot) && !isValidated && !hasRecipe;
            const showProposals = !isValidated;

                    const proposals = menuProposals?.[slot] || [];
                    const proposalLoading = !!proposalLoadingBySlot?.[slot];
                    const isValidating = !!validatingBySlot?.[slot];
                    const proposalError = proposalErrorBySlot?.[slot];
                    const people = normalizePeopleFromSlot(s?.people);
                    const totalPeople = peopleTotal(people);
                    const saved = !!savedRecipeIdsBySlot?.[slot];
                    const validatedRid = s?.recipe_id || null;
                    const validatedMeta = validatedRid ? recipeCache?.[validatedRid] : null;
                    const validatedSourceType = s?.source_type || null;
                    const validatedIsDrive =
                      validatedMeta?.source?.type === "DRIVE" ||
                      validatedSourceType === "DRIVE" ||
                      validatedSourceType === "DRIVE_INDEX";

            return (
              <tr
                key={slot}
                className="week-row"
                onClick={() => setSelectedSlot(slot)}
                onDragOver={(e) => {
                  if (!dragFromSlotRef.current) return;
                  e.preventDefault();
                  setDragOverSlot(slot);
                }}
                onDragLeave={() => {
                  if (dragOverSlot === slot) setDragOverSlot(null);
                }}
                onDrop={async (e) => {
                  e.preventDefault();
                  const from = dragFromSlotRef.current;
                  dragFromSlotRef.current = null;
                  setDragOverSlot(null);
                  if (!from || from === slot) return;
                  const ok = window.confirm(
                    `Déplacer ${getSlotLabel(from)} vers ${getSlotLabel(slot)} ?`
                  );
                  if (!ok) return;
                  await moveSlot(from, slot);
                }}
                style={{
                  background: isSelected ? "var(--accent-soft)" : "",
                  borderBottom: "1px solid var(--border)",
                  outline: dragOverSlot === slot ? "2px dashed var(--accent)" : ""
                }}
              >
                <td className="week-day-cell" style={{ width: 150, verticalAlign: "top", padding: "10px 6px" }}>
                  <div style={{ fontWeight: 400, fontSize: 15, display: "flex", alignItems: "center", gap: 6 }}>
                    {canDrag ? (
                      <span
                        draggable
                        onDragStart={(e) => {
                          dragFromSlotRef.current = slot;
                          try {
                            e.dataTransfer.setData("text/plain", slot);
                            e.dataTransfer.effectAllowed = "move";
                          } catch (_e) {}
                        }}
                        onDragEnd={() => {
                          dragFromSlotRef.current = null;
                          setDragOverSlot(null);
                        }}
                        title="Glisser pour déplacer"
                        style={{ cursor: "grab", userSelect: "none" }}
                      >
                        ⠿
                      </span>
                    ) : null}
                    <span>{getSlotLabel(slot)}</span>
                  </div>

                  {!isValidated &&
                    !FREE_TEXT_ALLOWED_SLOTS.has(slot) &&
                    (hasRecipe || (s?.free_text && s.free_text.trim()) || proposals.length > 0) && (
                    <>
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
                    </>
                  )}
                </td>

                <td className="week-content-cell" style={{ verticalAlign: "top", padding: "10px 6px 10px 0" }}>
                  {isValidated ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                      <div style={{ fontWeight: 400, fontSize: 15 }}>
                        <span
                          style={{ display: "inline-flex", alignItems: "baseline", gap: 6, cursor: "grab" }}
                          draggable
                          onDragStart={(e) => beginDrag(slot, e)}
                          onDragEnd={endDrag}
                          title="Glisser pour déplacer"
                        >
                          {validatedIsDrive ? <DriveIcon size={14} /> : null}
                          {validatedLabel(s)}
                        </span>
                      </div>
                      {!isFreeTextForced && (
                        <>
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
                              } else if (freeText && !s?.generated_recipe) {
                                prefetchFreeTextPreview(freeText, slotPeople);
                              }
                            }}
                            style={{ padding: "4px 6px" }}
                          />
                          <IconButton
                            icon="🔁"
                            label="Reproposer"
                            onClick={(e) => {
                              e.stopPropagation();
                              onReproposeValidated(slot);
                            }}
                            style={{ padding: "4px 6px" }}
                          />
                          {(() => {
                            const rid = s?.recipe_id || null;
                            const freeText = s?.free_text || null;
                            const signature = buildPeopleSignature(
                              normalizePeopleFromSlot(s?.people)
                            );
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
                            const isDrive =
                              meta?.source?.type === "DRIVE" ||
                              validatedSourceType === "DRIVE" ||
                              validatedSourceType === "DRIVE_INDEX";
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
                        </>
                      )}
                    </div>
                  ) : (
                    <>
                      {canFreeText && (
                        <textarea
                          style={{
                            display: "block",
                            width: "100%",
                            marginTop: 0,
                            padding: "2px 6px",
                            fontSize: 12,
                            lineHeight: "18px",
                            height: 24
                          }}
                          rows={1}
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

                      {showProposals && proposalLoading && (
                        <div
                          style={{ marginTop: 6, fontSize: 12 }}
                          className="status-loading"
                        >
                          Génération en cours…
                        </div>
                      )}
                      {showProposals && proposalError && (
                        <div
                          style={{ marginTop: 6, fontSize: 12 }}
                          className="status-error"
                        >
                          Erreur: {proposalError}
                        </div>
                      )}
                      {showProposals &&
                        proposals.map((p, idx) => {
                          const canDragProposal = !isValidated && proposals.length > 0;
                          return (
                            <div
                              key={p.proposal_id}
                              style={{
                                display: "flex",
                                gap: 8,
                                marginTop: idx === 0 ? 0 : 6,
                                alignItems: "center",
                                padding: "2px 8px",
                                border: "1px solid var(--border)",
                                borderRadius: 6,
                                background: "var(--bg-elev)",
                                lineHeight: "18px"
                              }}
                              onClick={(e) => e.stopPropagation()}
                              draggable={canDragProposal}
                              onDragStart={(e) => {
                                if (!canDragProposal) return;
                                beginDrag(slot, e);
                              }}
                              onDragEnd={endDrag}
                              title={
                                canDragProposal
                                  ? "Glisser pour déplacer cette proposition"
                                  : undefined
                              }
                            >
                              <span style={{ flex: 1 }}>
                                <span style={{ display: "inline-flex", alignItems: "baseline", gap: 6 }}>
                                  {canDragProposal ? (
                                    <span style={{ cursor: "grab", userSelect: "none" }}>⠿</span>
                                  ) : null}
                                  {p?.source === "DRIVE" || p?.source === "DRIVE_INDEX" ? (
                                    <DriveIcon size={14} />
                                  ) : null}
                                  {p.title}
                                </span>
                                {totalPeople ? ` · ${totalPeople} pers.` : ""}
                              </span>

                              <IconButton
                                icon="✅"
                                label={isValidating ? "Validation en cours" : "Valider pour la semaine"}
                                onClick={(e) => {
                                  e.stopPropagation();
                                  onValidateProposal(slot, p);
                                }}
                                disabled={isValidating}
                                style={{ padding: "4px 6px" }}
                              />
                              {isValidating ? (
                                <span style={{ fontSize: 11, opacity: 0.75 }}>
                                  Validation…
                                </span>
                              ) : null}
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

      <div className="divider-vertical" aria-hidden="true" />
      <aside
        className="panel week-sidebar week-sidebar-right"
        style={{
          width: 280,
          flexShrink: 0,
          display: "flex",
          flexDirection: "column",
          gap: 8,
          maxHeight: "calc(100vh - 32px)"
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div className="panel-title">Chat</div>
          <button
            type="button"
            onClick={clearChat}
            style={{
              fontSize: 13,
              padding: "2px 6px",
              borderRadius: 6,
              border: "1px solid #d1d5db",
              background: "#f9fafb",
              cursor: "pointer"
            }}
            aria-label="Clear chat"
          >
            🧹 Clear chat
          </button>
        </div>
        <div className="chat-input-row" style={{ display: "flex", gap: 6 }}>
          <textarea
            rows={4}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            placeholder="Écrire une demande..."
            style={{ flex: 1, fontSize: 13, resize: "vertical" }}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
              }
            }}
          />
          <button
            onClick={sendChatMessage}
            disabled={chatLoading || !chatInput.trim()}
            className="btn-side"
            style={{ fontSize: 13 }}
          >
            Envoyer
          </button>
        </div>
        <div
          style={{
            flex: 1,
            overflowY: "auto",
            border: "1px solid #f0f0f0",
            borderRadius: 8,
            padding: 8,
            background: "#fafafa"
          }}
        >
          {chatMessages.length === 0 ? (
            <div style={{ fontSize: 16, opacity: 0.7 }}>
              Dis-moi ce que tu veux changer (ex: “Pour mercredi dîner, je veux raclette”).
            </div>
          ) : (
            [...chatMessages].reverse().map((m) => (
              <div
                key={m.id}
                style={{
                  marginBottom: 8,
                  textAlign: m.role === "user" ? "right" : "left"
                }}
              >
                <div
                  style={{
                    display: "inline-block",
                    padding: "6px 8px",
                    borderRadius: 8,
                    background: m.role === "user" ? "var(--accent-soft)" : "var(--bg-elev)",
                    border: "1px solid var(--border)",
                    fontSize: 15
                  }}
                >
                  <span style={{ whiteSpace: "pre-wrap" }}>{m.text}</span>
                </div>
                {m.action && m.status === "pending" ? (
                  <div style={{ marginTop: 6, display: "flex", gap: 6 }}>
                    <button onClick={() => applyChatAction(m.id, m.action)}>
                      {m.action?.action_type === "force_menu_confirm"
                        ? "Oui (menu)"
                        : m.action?.action_type === "force_menu_recipe" ||
                            m.action?.action_type === "force_menu"
                          ? "Oui (recette)"
                          : "Valider"}
                    </button>
                    <button onClick={() => rejectChatAction(m.id)}>
                      {m.action?.action_type === "force_menu_confirm"
                        ? "Non"
                        : m.action?.action_type === "force_menu_recipe" ||
                            m.action?.action_type === "force_menu"
                          ? "Non (sans recette)"
                          : "Refuser"}
                    </button>
                  </div>
                ) : null}
              </div>
            ))
          )}
        </div>
      </aside>

      {proposalModal && (
        <div onClick={closeProposalModal} className="modal-overlay">
          <div
            onClick={(e) => e.stopPropagation()}
            className="modal"
            style={{
              width: "min(1100px, 96vw)",
              padding: 16
            }}
          >
            <div style={{ display: "flex", alignItems: "center" }}>
              <div className="modal-title">
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
                <div style={{ marginTop: 8 }} className="status-loading">
                  Chargement...
                </div>
              )}

              {proposalError && (
                <div style={{ marginTop: 8 }} className="status-error">
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

      {shoppingOpen && (
        <div onClick={() => setShoppingOpen(false)} className="modal-overlay">
          <div
            onClick={(e) => e.stopPropagation()}
            className="modal"
            style={{
              width: "min(1100px, 96vw)",
              height: isMenuMode ? "auto" : "80vh",
              maxHeight: "80vh",
              padding: 16,
              display: "flex",
              flexDirection: "column"
            }}
          >
            <div style={{ display: "flex", alignItems: "center" }}>
              <div className="modal-title">
                {keepMode === "menus"
                  ? "Menus"
                  : keepMode === "recipes"
                    ? "Recettes"
                    : "Courses"}
              </div>
              {keepText ? (
                <button
                  onClick={() => {
                    try {
                      navigator.clipboard.writeText(keepText);
                    } catch (_e) {}
                  }}
                  className="btn-modal"
                  style={{ marginLeft: 10 }}
                >
                  Copier
                </button>
              ) : null}
              <button
                onClick={() => setShoppingOpen(false)}
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

            {shoppingLoading && (
              <div style={{ marginTop: 8 }} className="status-loading">
                Chargement...
              </div>
            )}
            {shoppingError && (
              <div style={{ marginTop: 8 }} className="status-error">
                {shoppingError}
              </div>
            )}

            {!shoppingLoading && !shoppingError && (
              <div style={{ marginTop: 10, flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
                {keepMode === "shopping" ? (
                  <div style={{ fontSize: 12, opacity: 0.7, marginBottom: 6 }}>
                    Coche ce que tu as deja au placard. Le reste = a acheter.
                  </div>
                ) : null}
                {(!shoppingList?.items || shoppingList.items.length === 0) && (
                  <div style={{ fontSize: 12, opacity: 0.75, marginBottom: 8 }}>
                    Aucune recette validee avec ingredients. Valide une recette
                    pour generer la liste de courses.
                  </div>
                )}
                {keepText ? (
                  <textarea
                    readOnly
                    value={keepText}
                    rows={menuRows}
                    style={{
                      width: "100%",
                      fontFamily: "monospace",
                      fontSize: 12,
                      flex: isMenuMode ? "none" : 1,
                      minHeight: 0,
                      height: isMenuMode ? "auto" : undefined,
                      resize: isMenuMode ? "none" : undefined
                    }}
                  />
                ) : null}
                {keepMode === "shopping" ? (
                  <>
                    <div style={{ flex: 1, minHeight: 0, overflowY: "auto" }}>
                      {(() => {
                        const consolidated = consolidateShoppingItems(shoppingList?.items || []);
                        const unchecked = [];
                        const checked = [];
                        consolidated.forEach((it) => {
                          const key = `${it.item}__${it.unit || ""}`;
                          if (pantryChecked[key]) checked.push(it);
                          else unchecked.push(it);
                        });
                        unchecked.sort((a, b) => {
                          const ka = `${a.item}__${a.unit || ""}`;
                          const kb = `${b.item}__${b.unit || ""}`;
                          return (pantryOrder[ka] || 0) - (pantryOrder[kb] || 0);
                        });
                        return unchecked.concat(checked).map((it, idx) => {
                          const key = `${it.item}__${it.unit || ""}`;
                          const isChecked = !!pantryChecked[key];
                          return (
                            <label
                              key={`${key}-${idx}`}
                              style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                padding: "4px 0",
                                opacity: isChecked ? 0.5 : 1
                              }}
                            >
                              <input
                                type="checkbox"
                                checked={isChecked}
                                onChange={(e) =>
                                  {
                                    const nextChecked = e.target.checked;
                                    setPantryChecked((prev) => ({
                                      ...prev,
                                      [key]: nextChecked
                                    }));
                                    setPantryOrder((prev) => ({
                                      ...prev,
                                      [key]: Date.now()
                                    }));
                                  }
                                }
                              />
                              <span style={{ textDecoration: isChecked ? "line-through" : "none" }}>
                                {it.qty ? `${it.qty} ` : ""}
                                {it.unit ? `${it.unit} ` : ""}
                                {it.item}
                              </span>
                            </label>
                          );
                        });
                      })()}
                    </div>
                    {(shoppingList?.missing_recipes || []).length > 0 && (
                      <div style={{ marginTop: 10, fontSize: 12, opacity: 0.75 }}>
                        Recettes sans ingredients:{" "}
                        {(shoppingList.missing_recipes || [])
                          .map((r) => r.title)
                          .join(", ")}
                      </div>
                    )}
                  </>
                ) : null}
              </div>
            )}
          </div>
        </div>
      )}

      {recipeModal && (
        <div onClick={closeRecipeModal} className="modal-overlay">
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
              <div style={{ marginTop: 8 }} className="status-loading">
                Chargement...
              </div>
            )}
            {recipeModalError && (
              <div style={{ marginTop: 8 }} className="status-error">
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
