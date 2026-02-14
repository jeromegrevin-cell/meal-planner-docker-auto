import express from "express";
import path from "path";
import fs from "fs/promises";
import fsSync from "fs";
import { DATA_DIR, PROJECT_ROOT } from "../lib/dataPaths.js";
import OpenAI from "openai";
import { readJson, writeJson } from "../lib/jsonStore.js";

const router = express.Router();

const CHAT_DIR = path.join(DATA_DIR, "chat_sessions");
const RECIPES_DIR = path.join(DATA_DIR, "recipes");
const CONSTRAINTS_PATH = path.join(DATA_DIR, "constraints.json");
const STATIC_CONSTRAINTS_PATH = path.join(
  PROJECT_ROOT,
  "frontend",
  "src",
  "data",
  "constraints.json"
);
const CHAT_PERSIST = process.env.CHAT_PERSIST !== "0";
const CHAT_RETENTION_DAYS = Number(process.env.CHAT_RETENTION_DAYS || 0);
const HISTORY_WEEKS_LIMIT = Number(process.env.MEAL_PLANNER_HISTORY_WEEKS || 8);

// ---------- OpenAI lazy client ----------
let cachedClient = null;
let cachedKey = null;

function resolveSecretsDir() {
  const secretsDir = (process.env.MEAL_PLANNER_SECRETS_DIR || "").trim();
  if (secretsDir) return secretsDir;
  const fallback = path.join(PROJECT_ROOT, "credentials");
  if (fsSync.existsSync(fallback)) return fallback;
  return "";
}

function readOpenAIKeyFromSecretsDir() {
  const secretsDir = resolveSecretsDir();
  if (!secretsDir) return "";
  const keyPath = path.join(secretsDir, "openai_api_key.txt");
  if (!fsSync.existsSync(keyPath)) return "";
  try {
    const raw = fsSync.readFileSync(keyPath, "utf8");
    return String(raw || "").trim();
  } catch {
    return "";
  }
}

function getOpenAIClient() {
  const key = (process.env.OPENAI_API_KEY || "").trim() || readOpenAIKeyFromSecretsDir();
  if (!key) return null;

  if (!cachedClient || cachedKey !== key) {
    cachedClient = new OpenAI({ apiKey: key });
    cachedKey = key;
  }
  return cachedClient;
}

function getModel() {
  return process.env.OPENAI_MODEL || "gpt-5.2";
}

function getCheapModel() {
  return process.env.OPENAI_MODEL_CHEAP || process.env.OPENAI_MODEL || "gpt-5.2";
}

function getMenuGenerateModel() {
  return process.env.OPENAI_MODEL_MENU || getCheapModel();
}

function getMenuGenerateAiMaxSlots() {
  const v = Number(process.env.MEAL_PLANNER_MENU_AI_MAX_SLOTS || 0);
  return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

function getMenuGenerateAttempts() {
  const v = Number(process.env.MEAL_PLANNER_MENU_AI_ATTEMPTS || 1);
  return Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 1;
}

// ---------- Utils ----------
let cachedStaticConstraints = null;
let cachedStaticConstraintsMtime = 0;

function nowIso() {
  return new Date().toISOString();
}

async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

async function readConstraints() {
  try {
    const raw = await readJson(CONSTRAINTS_PATH);
    return {
      global: Array.isArray(raw?.global) ? raw.global : [],
      weeks: typeof raw?.weeks === "object" && raw?.weeks ? raw.weeks : {}
    };
  } catch {
    return { global: [], weeks: {} };
  }
}

function normalizeStaticConstraints(raw) {
  const sections = Array.isArray(raw)
    ? raw
    : Array.isArray(raw?.sections)
      ? raw.sections
      : [];
  return sections
    .map((section) => {
      const title = String(section?.title || "").trim();
      const items = Array.isArray(section?.items)
        ? section.items.map((item) => String(item || "").trim()).filter(Boolean)
        : [];
      return { title, items };
    })
    .filter((section) => section.title || section.items.length);
}

function loadStaticConstraintsSections() {
  try {
    if (!STATIC_CONSTRAINTS_PATH) return [];
    const stat = fsSync.statSync(STATIC_CONSTRAINTS_PATH);
    if (cachedStaticConstraints && stat.mtimeMs === cachedStaticConstraintsMtime) {
      return cachedStaticConstraints;
    }
    const raw = fsSync.readFileSync(STATIC_CONSTRAINTS_PATH, "utf8");
    const parsed = JSON.parse(raw);
    const normalized = normalizeStaticConstraints(parsed);
    cachedStaticConstraints = normalized;
    cachedStaticConstraintsMtime = stat.mtimeMs;
    return normalized;
  } catch {
    return [];
  }
}

function buildStaticConstraintsPromptLines() {
  const sections = loadStaticConstraintsSections();
  if (!sections.length) return [];
  const lines = ["Contraintes Accueil (système):"];
  for (const section of sections) {
    const title = section.title ? `${section.title}: ` : "";
    const body = section.items.length ? section.items.join(" | ") : "";
    const text = `${title}${body}`.trim();
    if (text) lines.push(`- ${text}`);
  }
  return lines;
}

function buildStaticConstraintsPromptSummaryLines() {
  const summary = [
    "Repas: pas de déjeuner lun/mar/jeu/ven; autres repas remplis ou reste/congélateur.",
    "Portions: 3 pers (2A+1E 9 ans), quantités adaptées, préciser différences si besoin.",
    "Nutrition: ~500 kcal/adulte/repas, enfant proche, pas de menus déséquilibrés.",
    "Saison: légumes de saison, courgette hors saison interdite; équivalences cru/cuit: pâtes x2,5; riz x3; semoule x2; légumineuses x3; PDT x1; patate douce x1.",
    "Répétition: ingrédient principal max 2x/sem, si 2x alors ≥2 jours d’écart.",
    "Sources: mix recettes générées + Drive; demander index Drive à jour sinon rescan.",
    "Courses: liste obligatoire après validation, tableau ingrédient/qté/recettes, cohérence stricte.",
    "Budget: cible ≤60€ (Lidl+Carrefour).",
    "Qualité: double vérif verticale/horizontale; zéro ingrédient fantôme; corriger immédiatement."
  ];
  return ["Contraintes Accueil (résumé):", ...summary.map((line) => `- ${line}`)];
}

function buildStaticConstraintsReplyLines() {
  const sections = loadStaticConstraintsSections();
  if (!sections.length) return [];
  const lines = ["- Contraintes Accueil (système):"];
  for (const section of sections) {
    const title = section.title ? `${section.title}: ` : "";
    const body = section.items.length ? section.items.join(" | ") : "";
    const text = `${title}${body}`.trim();
    if (text) lines.push(`- ${text}`);
  }
  return lines;
}

async function writeConstraints(next) {
  const payload = {
    global: Array.isArray(next?.global) ? next.global : [],
    weeks: typeof next?.weeks === "object" && next?.weeks ? next.weeks : {}
  };
  await writeJson(CONSTRAINTS_PATH, payload);
  return payload;
}

function normalizeConstraint(text) {
  return String(text || "").trim().replace(/\s+/g, " ");
}

function formatRecipePreview(title, preview) {
  const lines = [];
  if (title) lines.push(title);
  if (preview?.description_courte) {
    lines.push("");
    lines.push(preview.description_courte);
  }
  if (Array.isArray(preview?.ingredients) && preview.ingredients.length) {
    lines.push("");
    lines.push("Ingrédients:");
    for (const ing of preview.ingredients) {
      const qty = ing?.qty ? `${ing.qty} ` : "";
      const unit = ing?.unit ? `${ing.unit} ` : "";
      const item = ing?.item || "";
      lines.push(`- ${qty}${unit}${item}`.trim());
    }
  }
  if (Array.isArray(preview?.preparation_steps) && preview.preparation_steps.length) {
    lines.push("");
    lines.push("Étapes:");
    preview.preparation_steps.forEach((step, idx) => {
      lines.push(`${idx + 1}. ${step}`);
    });
  }
  return lines.join("\n");
}

async function listLocalRecipes() {
  await ensureDir(RECIPES_DIR);
  const files = await fs.readdir(RECIPES_DIR);
  const jsonFiles = files.filter((f) => f.endsWith(".json"));
  const recipes = [];
  for (const f of jsonFiles) {
    try {
      const p = path.join(RECIPES_DIR, f);
      const r = await readJson(p);
      if (!r || typeof r !== "object") continue;
      const title = String(r.title || "").trim();
      if (!title || title.toLowerCase().includes("placeholder")) continue;
      recipes.push({
        recipe_id: r.recipe_id || f.replace(".json", ""),
        title
      });
    } catch {
      // ignore unreadable recipes
    }
  }
  return recipes;
}

function shuffle(arr) {
  const out = [...arr];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function pruneChatSessions() {
  if (!CHAT_PERSIST || !CHAT_RETENTION_DAYS || CHAT_RETENTION_DAYS < 1) return;

  await ensureDir(CHAT_DIR);
  const cutoff = Date.now() - CHAT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

  const files = await fs.readdir(CHAT_DIR);
  await Promise.all(
    files
      .filter((f) => f.endsWith(".json"))
      .map(async (f) => {
        const p = path.join(CHAT_DIR, f);
        try {
          const st = await fs.stat(p);
          if (st.mtimeMs < cutoff) {
            await fs.unlink(p);
          }
        } catch {
          // Ignore per-file errors (best-effort cleanup)
        }
      })
  );
}

if (CHAT_PERSIST && CHAT_RETENTION_DAYS > 0) {
  // Best-effort cleanup at startup + daily
  pruneChatSessions().catch(() => {});
  setInterval(() => {
    pruneChatSessions().catch(() => {});
  }, 24 * 60 * 60 * 1000);
}

function chatPath(weekId) {
  return path.join(CHAT_DIR, `${weekId}.json`);
}

function normalizeSlotKey(slot) {
  return String(slot || "").trim();
}

function normalizeTitle(title) {
  return String(title || "").trim();
}

function normalizeKey(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function normalizePlain(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function isLeftoverTitle(title) {
  const t = normalizePlain(title);
  if (!t) return false;
  return (
    /\brestes?\b/.test(t) ||
    /\bcongelateur\b/.test(t) ||
    /\bcongele\b/.test(t) ||
    /\bcongel\b/.test(t)
  );
}

const MAIN_INGREDIENT_PATTERNS = [
  {
    key: "pommes_de_terre",
    label: "pommes de terre",
    terms: ["pomme de terre", "pommes de terre", "pdt", "patate", "patates", "dauphinois"]
  },
  {
    key: "pates",
    label: "pâtes",
    terms: [
      "pates",
      "pâtes",
      "spaghetti",
      "penne",
      "fusilli",
      "tagliatelle",
      "macaroni",
      "lasagnes",
      "lasagna"
    ]
  },
  { key: "poulet", label: "poulet", terms: ["poulet", "volaille"] },
  { key: "dinde", label: "dinde", terms: ["dinde"] },
  { key: "boeuf", label: "boeuf", terms: ["boeuf", "bœuf", "steak", "hach", "entrecote"] },
  { key: "porc", label: "porc", terms: ["porc", "jambon", "lard", "bacon", "saucisse", "chorizo"] },
  { key: "agneau", label: "agneau", terms: ["agneau", "mouton"] },
  {
    key: "poisson",
    label: "poisson",
    terms: ["saumon", "cabillaud", "thon", "truite", "colin", "lieu", "merlu", "dorade", "bar", "sole", "maquereau", "sardine", "poisson"]
  },
  {
    key: "fruits_de_mer",
    label: "fruits de mer",
    terms: ["crevette", "moule", "calamar", "seiche", "poulpe", "crabe", "langoustine"]
  },
  { key: "oeufs", label: "oeufs", terms: ["oeuf", "œuf", "omelette", "frittata"] },
  { key: "tofu", label: "tofu", terms: ["tofu", "tempeh"] },
  {
    key: "legumineuses",
    label: "legumineuses",
    terms: ["lentille", "pois chiche", "haricot", "pois casse", "pois cass"]
  },
  {
    key: "fromage",
    label: "fromage",
    terms: ["raclette", "fromage", "mozzarella", "chevre", "chèvre", "feta", "comte", "comté", "emmental", "gruyere", "gruyère", "parmesan"]
  }
];

function mainIngredientKeyFromTitle(title) {
  const msg = normalizePlain(title);
  if (!msg) return "";
  for (const group of MAIN_INGREDIENT_PATTERNS) {
    for (const term of group.terms) {
      const t = normalizePlain(term);
      if (t && msg.includes(t)) return group.key;
    }
  }
  return "";
}

function mainIngredientLabel(key) {
  if (!key) return "";
  const found = MAIN_INGREDIENT_PATTERNS.find((g) => g.key === key);
  return found ? found.label : key;
}

async function listWeekFiles() {
  try {
    const files = await fs.readdir(path.join(DATA_DIR, "weeks"));
    return files.filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
}

async function readRecipeTitleById(recipeId, cache) {
  if (!recipeId) return "";
  if (cache.has(recipeId)) return cache.get(recipeId) || "";
  const p = path.join(RECIPES_DIR, `${recipeId}.json`);
  try {
    const data = await readJson(p);
    const title = String(data?.title || "").trim();
    cache.set(recipeId, title);
    return title;
  } catch {
    cache.set(recipeId, "");
    return "";
  }
}

async function collectWeekSlotTitles(weekData, recipeCache) {
  const titles = [];
  const slots = weekData?.slots || {};
  for (const slot of Object.keys(slots)) {
    const slotData = slots[slot] || {};
    const free = String(slotData?.free_text || "").trim();
    if (free) {
      titles.push(free);
      continue;
    }
    const recipeId = String(slotData?.recipe_id || "").trim();
    if (recipeId) {
      const t = await readRecipeTitleById(recipeId, recipeCache);
      if (t) titles.push(t);
    }
  }
  return titles;
}

async function collectHistoricalIngredientKeys(currentWeekId, limit) {
  const files = await listWeekFiles();
  const recipeCache = new Map();
  const weeks = [];
  for (const f of files) {
    const weekId = f.replace(/\.json$/i, "");
    if (!weekId || weekId === currentWeekId) continue;
    try {
      const data = await readJson(path.join(DATA_DIR, "weeks", f));
      const dateEnd = String(data?.date_end || "");
      const ts = Date.parse(dateEnd ? `${dateEnd}T00:00:00Z` : "");
      weeks.push({ weekId, ts, data });
    } catch {
      // ignore unreadable week
    }
  }
  weeks.sort((a, b) => (Number.isFinite(b.ts) ? b.ts : 0) - (Number.isFinite(a.ts) ? a.ts : 0));
  const sliced = limit > 0 ? weeks.slice(0, limit) : weeks;

  const used = new Set();
  for (const w of sliced) {
    const titles = await collectWeekSlotTitles(w.data, recipeCache);
    for (const t of titles) {
      const key = mainIngredientKeyFromTitle(t);
      if (key) used.add(key);
    }
  }
  return used;
}

function titleKey(title) {
  const base = normalizeKey(title);
  if (!base) return "";
  const stop = new Set(["de", "du", "des", "la", "le", "les", "au", "aux", "a", "et", "en", "d", "l"]);
  const tokens = base.split(" ").filter((t) => t && !stop.has(t));
  tokens.sort();
  return tokens.join(" ");
}

const SLOT_LABELS = {
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

const SLOT_DAY_INDEX = {
  sat: 0,
  sun: 1,
  mon: 2,
  tue: 3,
  wed: 4,
  thu: 5,
  fri: 6
};

function slotDayIndex(slot) {
  const prefix = String(slot || "").split("_")[0];
  if (!prefix) return null;
  return Number.isFinite(SLOT_DAY_INDEX[prefix]) ? SLOT_DAY_INDEX[prefix] : null;
}

function detectCancelSlot(message) {
  const msg = normalizePlain(message);
  if (!msg) return null;

  const cancelHints = [
    "annule",
    "annuler",
    "supprime",
    "supprimer",
    "pas de repas",
    "pas de menu",
    "rien",
    "vide"
  ];
  const hasCancel = cancelHints.some((h) => msg.includes(h));
  if (!hasCancel) return null;

  const dayMap = {
    lundi: "mon",
    mardi: "tue",
    mercredi: "wed",
    jeudi: "thu",
    vendredi: "fri",
    samedi: "sat",
    dimanche: "sun"
  };
  const lunchHints = ["dejeuner", "dejeuner", "midi"];
  const dinnerHints = ["diner", "diner", "soir"];

  let day = null;
  for (const [label, prefix] of Object.entries(dayMap)) {
    if (msg.includes(label)) {
      day = prefix;
      break;
    }
  }
  if (!day) return null;

  const isLunch = lunchHints.some((h) => msg.includes(h));
  const isDinner = dinnerHints.some((h) => msg.includes(h));
  if (isLunch && !isDinner) return `${day}_lunch`;
  if (isDinner && !isLunch) return `${day}_dinner`;

  // ambiguous meal -> ask clarification
  return null;
}

function detectListConstraints(message) {
  const msg = normalizePlain(message);
  if (!msg) return false;
  const keywords = [
    "contraintes",
    "contrainte",
    "liste des contraintes",
    "rappel contraintes",
    "rappelle les contraintes",
    "rappelle moi les contraintes",
    "mes contraintes",
    "quelles contraintes"
  ];
  return keywords.some((k) => msg.includes(normalizePlain(k)));
}

function formatConstraintsReply(weekId, weekData, constraints) {
  const globalList = Array.isArray(constraints?.global) ? constraints.global : [];
  const weekList = Array.isArray(constraints?.weeks?.[weekId])
    ? constraints.weeks[weekId]
    : [];

  const lines = [];
  lines.push("Contraintes enregistrées:");
  lines.push(
    `- Permanentes: ${globalList.length ? globalList.join(" | ") : "aucune"}`
  );
  lines.push(
    `- Semaine ${weekId}: ${weekList.length ? weekList.join(" | ") : "aucune"}`
  );

  const rules = weekData?.rules_readonly || {};
  const noLunchSlots = Array.isArray(rules.no_lunch_slots) ? rules.no_lunch_slots : [];
  if (noLunchSlots.length) {
    const labels = noLunchSlots.map((s) => SLOT_LABELS[s] || s).join(", ");
    lines.push(`- Règles semaine (système): pas de déjeuner pour ${labels}`);
  }
  if (Number.isFinite(rules.main_ingredient_max_per_week)) {
    lines.push(
      `- Règles semaine (système): ingrédient principal max ${rules.main_ingredient_max_per_week} fois/semaine`
    );
  }
  if (Number.isFinite(rules.min_days_between_repeat)) {
    lines.push(
      `- Règles semaine (système): ${rules.min_days_between_repeat} jours mini entre répétitions`
    );
  }
  if (rules.people) {
    const adults = Number.isFinite(rules.people?.adults) ? rules.people.adults : 0;
    const children = Number.isFinite(rules.people?.children) ? rules.people.children : 0;
    lines.push(`- Règles semaine (système): ${adults} adulte(s), ${children} enfant(s)`);
  }

  const staticLines = buildStaticConstraintsReplyLines();
  if (staticLines.length) {
    lines.push(...staticLines);
  }

  lines.push("Si une proposition ne respecte pas ces contraintes, dis-moi laquelle.");
  return lines.join("\n");
}

function detectMoveProposal(message) {
  const raw = String(message || "").trim();
  if (!raw) return null;
  const msg = normalizePlain(raw);
  if (!msg) return null;

  const dayMap = {
    lundi: "mon",
    mardi: "tue",
    mercredi: "wed",
    jeudi: "thu",
    vendredi: "fri",
    samedi: "sat",
    dimanche: "sun"
  };
  const lunchHints = ["dejeuner", "midi"];
  const dinnerHints = ["diner", "soir"];

  const matches = [];
  const re = /(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(dejeuner|midi|diner|soir)/g;
  let m;
  while ((m = re.exec(msg)) !== null) {
    const day = dayMap[m[1]];
    const meal = m[2];
    const isLunch = lunchHints.includes(meal);
    const isDinner = dinnerHints.includes(meal);
    if (!day || (isLunch && isDinner) || (!isLunch && !isDinner)) continue;
    matches.push(`${day}_${isLunch ? "lunch" : "dinner"}`);
    if (matches.length >= 2) break;
  }
  if (matches.length < 2) return null;
  if (matches[0] === matches[1]) return null;

  return { from_slot: matches[0], to_slot: matches[1] };
}

function detectWeekBanConstraint(message) {
  const raw = String(message || "").trim();
  if (!raw) return null;
  const msg = normalizePlain(raw);
  if (!msg) return null;

  const patterns = [
    /\bpas de\s+(.+)$/i,
    /\bplus de\s+(.+)$/i,
    /\bevite\s+(.+)$/i,
    /\bévite\s+(.+)$/i
  ];

  let item = "";
  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1]) {
      item = String(m[1]).trim();
      break;
    }
  }
  if (!item) return null;

  const trailing = ["cette semaine", "cette semaine-ci", "cette semaine ci", "pour cette semaine"];
  const itemNorm = normalizePlain(item);
  for (const t of trailing) {
    const tNorm = normalizePlain(t);
    if (itemNorm.endsWith(tNorm)) {
      item = item.slice(0, itemNorm.length - tNorm.length).trim();
      break;
    }
  }
  item = item.replace(/^[\"'«»]+|[\"'«»]+$/g, "").trim();
  if (!item) return null;

  return { constraint: `Interdit: ${item}` };
}

function stripTitlePrefixes(title) {
  let out = String(title || "").trim();
  if (!out) return "";
  const prefixes = [
    /^donne\s+moi\s+/i,
    /^donne-moi\s+/i,
    /^donne\s+moi\s+un[e]?\s+/i,
    /^donne-moi\s+un[e]?\s+/i,
    /^propose\s+moi\s+/i,
    /^propose-moi\s+/i,
    /^propose\s+moi\s+un[e]?\s+/i,
    /^propose-moi\s+un[e]?\s+/i,
    /^propose\s+un[e]?\s+/i,
    /^je\s+veux\s+/i,
    /^je\s+voudrais\s+/i,
    /^je\s+souhaite\s+/i,
    /^j['’]aimerais\s+/i,
    /^mets?\s+/i,
    /^mettez\s+/i,
    /^ajoute\s+/i,
    /^ajouter\s+/i,
    /^une\s+recette\s+de\s+/i,
    /^recette\s+de\s+/i,
    /^recette\s+d['’]\s*/i
  ];
  for (const re of prefixes) {
    out = out.replace(re, "");
  }
  return out.trim();
}

function detectTitleForSlot(message) {
  const raw = String(message || "").trim();
  if (!raw) return null;
  const msg = normalizePlain(raw);
  if (!msg) return null;

  const dayMap = {
    lundi: "mon",
    mardi: "tue",
    mercredi: "wed",
    jeudi: "thu",
    vendredi: "fri",
    samedi: "sat",
    dimanche: "sun"
  };
  const slotRe =
    /(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(dejeuner|déjeuner|midi|diner|dîner|soir)/i;
  const slotMatch = raw.match(slotRe);
  if (!slotMatch) return null;
  const day = dayMap[normalizePlain(slotMatch[1])];
  const meal = normalizePlain(slotMatch[2]);
  const isLunch = meal === "dejeuner" || meal === "midi";
  const slot = `${day}_${isLunch ? "lunch" : "dinner"}`;
  if (!SLOT_LABELS[slot]) return null;

  let title = "";
  const pourRe =
    /\bpour\s+(?:le|la|du|au|aux|des)?\s*(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(dejeuner|déjeuner|midi|diner|dîner|soir)\b/i;
  const pourMatch = raw.match(pourRe);
  if (pourMatch?.index != null && pourMatch.index > 0) {
    title = raw.slice(0, pourMatch.index).trim();
  } else if (slotMatch?.index != null) {
    const after = raw.slice(slotMatch.index + slotMatch[0].length).trim();
    if (after) {
      title = after.replace(/^[:\-\u2013\u2014>\s]+/, "").trim();
    }
  }
  if (!title && slotMatch?.index != null && slotMatch.index > 0) {
    title = raw.slice(0, slotMatch.index).trim();
  }

  title = stripTitlePrefixes(title);
  title = title.replace(/^["'«»]+|["'«»]+$/g, "").trim();

  const normalizedTitle = normalizePlain(title);
  const useless = new Set([
    "quoi",
    "quel",
    "quelle",
    "quels",
    "quelles",
    "que",
    "quelque chose",
    "recette",
    "une recette",
    "un plat",
    "plat",
    "menu",
    "un menu"
  ]);
  const intentKeywords = [
    "donne",
    "propose",
    "mets",
    "mettez",
    "je veux",
    "je voudrais",
    "je souhaite",
    "j aime",
    "recette",
    "plat",
    "menu"
  ];
  const hasIntent = intentKeywords.some((k) => msg.includes(k));
  if (!normalizedTitle || useless.has(normalizedTitle)) {
    return hasIntent ? { slot, title: "" } : null;
  }

  return { slot, title };
}

function detectRecipeForSlot(message) {
  const raw = String(message || "").trim();
  if (!raw) return null;
  const msg = normalizePlain(raw);
  if (!msg || !msg.includes("recette")) return null;

  const dayMap = {
    lundi: "mon",
    mardi: "tue",
    mercredi: "wed",
    jeudi: "thu",
    vendredi: "fri",
    samedi: "sat",
    dimanche: "sun"
  };
  const slotRe =
    /(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(dejeuner|midi|diner|soir)/i;
  const slotMatch = msg.match(slotRe);
  if (!slotMatch) return null;
  const day = dayMap[slotMatch[1]];
  const meal = slotMatch[2];
  const isLunch = meal === "dejeuner" || meal === "midi";
  const slot = `${day}_${isLunch ? "lunch" : "dinner"}`;
  if (!SLOT_LABELS[slot]) return null;

  const patterns = [
    /recette\s+d['e]\s*([^,.!?]+?)(?:\s+pour\s+(?:le|la|du|au|aux|des)?\s*(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(?:dejeuner|déjeuner|midi|diner|dîner|soir)|$)/i,
    /pour\s+(?:le|la|du|au|aux|des)?\s*(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(?:dejeuner|déjeuner|midi|diner|dîner|soir)[^a-zA-Z0-9]+(?:une\s+)?recette\s+d['e]\s*([^,.!?]+)$/i
  ];

  let title = "";
  for (const re of patterns) {
    const m = raw.match(re);
    if (m && m[1]) {
      title = String(m[1]).trim();
      break;
    }
  }

  if (!title) {
    const lower = raw.toLowerCase();
    let idx = lower.indexOf("recette de");
    let offset = "recette de".length;
    if (idx === -1) {
      idx = lower.indexOf("recette d'");
      offset = "recette d'".length;
    }
    if (idx !== -1) {
      title = raw.slice(idx + offset).trim();
      title = title.replace(/^[:,-]\s*/g, "");
      const tailRe =
        /\b(pour|du)\s+(?:le|la|du|au|aux|des)?\s*(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(dejeuner|déjeuner|midi|diner|dîner|soir)\b/i;
      const tailMatch = title.match(tailRe);
      if (tailMatch) {
        title = title.slice(0, tailMatch.index).trim();
      }
    }
  }

  title = title.replace(/^["'«»]+|["'«»]+$/g, "").trim();

  return { slot, title };
}

function detectSlotInMessage(message) {
  const raw = String(message || "").trim();
  if (!raw) return null;
  const msg = normalizePlain(raw);
  if (!msg) return null;

  const dayMap = {
    lundi: "mon",
    mardi: "tue",
    mercredi: "wed",
    jeudi: "thu",
    vendredi: "fri",
    samedi: "sat",
    dimanche: "sun"
  };
  const slotRe =
    /(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(dejeuner|déjeuner|midi|diner|dîner|soir)/i;
  const slotMatch = raw.match(slotRe);
  if (!slotMatch) return null;
  const day = dayMap[normalizePlain(slotMatch[1])];
  const meal = normalizePlain(slotMatch[2]);
  const isLunch = meal === "dejeuner" || meal === "midi";
  const slot = `${day}_${isLunch ? "lunch" : "dinner"}`;
  return SLOT_LABELS[slot] ? slot : null;
}

function tokenizeForMatch(text) {
  const base = normalizePlain(text);
  if (!base) return [];
  const stop = new Set([
    "de",
    "du",
    "des",
    "la",
    "le",
    "les",
    "au",
    "aux",
    "a",
    "et",
    "en",
    "d",
    "l",
    "un",
    "une",
    "pour",
    "avec",
    "sans",
    "recette",
    "plat",
    "menu"
  ]);
  return base
    .split(" ")
    .map((t) => t.trim())
    .filter((t) => t && !stop.has(t));
}

function extractRecipeQuery(message) {
  const raw = String(message || "").trim();
  if (!raw) return "";
  let text = raw;
  const slotRe =
    /(lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+(dejeuner|déjeuner|midi|diner|dîner|soir)/i;
  const slotMatch = text.match(slotRe);
  if (slotMatch?.index != null) {
    text = text.slice(0, slotMatch.index).trim();
    text = text.replace(/\b(pour|le|la|du)\s*$/i, "").trim();
  }
  text = stripTitlePrefixes(text);
  text = text.replace(/\b(recette|plats?|menu)\b/i, "").trim();
  return text;
}

function rankTitlesByQuery(titles, query, usedTitles = null) {
  const qTokens = tokenizeForMatch(query);
  const scored = [];
  for (const title of titles) {
    const t = String(title || "").trim();
    if (!t) continue;
    const tLower = t.toLowerCase();
    if (usedTitles && usedTitles.has(tLower)) continue;
    if (!qTokens.length) {
      scored.push({ title: t, score: 0 });
      continue;
    }
    const tTokens = new Set(tokenizeForMatch(t));
    let score = 0;
    for (const token of qTokens) {
      if (tTokens.has(token)) score += 1;
    }
    if (score > 0) scored.push({ title: t, score });
  }
  if (!scored.length) return [];
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.title.length - b.title.length;
  });
  return scored.map((s) => s.title);
}

async function collectUsedTitlesForWeek(weekData, menuProposals) {
  const used = new Set();
  const slots = weekData?.slots || {};
  const recipeCache = new Map();
  for (const slot of Object.keys(slots)) {
    const slotData = slots[slot] || {};
    const free = String(slotData?.free_text || "").trim();
    if (free) {
      used.add(free.toLowerCase());
      continue;
    }
    const recipeId = String(slotData?.recipe_id || "").trim();
    if (recipeId) {
      const t = await readRecipeTitleById(recipeId, recipeCache);
      if (t) used.add(t.toLowerCase());
    }
  }
  for (const listRaw of Object.values(menuProposals || {})) {
    const list = Array.isArray(listRaw) ? listRaw : [];
    for (const p of list) {
      const t = String(p?.title || "").trim();
      if (t) used.add(t.toLowerCase());
    }
  }
  return used;
}

function detectRecipeSuggestionRequest(message) {
  const raw = String(message || "").trim();
  if (!raw) return null;
  const msg = normalizePlain(raw);
  if (!msg) return null;
  const intent = [
    "propose",
    "propose moi",
    "propose-moi",
    "donne moi",
    "donne-moi",
    "suggere",
    "suggere moi",
    "suggere-moi",
    "recette"
  ];
  const hasIntent = intent.some((k) => msg.includes(normalizePlain(k)));
  if (!hasIntent) return null;
  const slot = detectSlotInMessage(raw);
  const query = extractRecipeQuery(raw);
  return { slot, query };
}

function wantsMoreRecipes(message) {
  const msg = normalizePlain(message);
  if (!msg) return false;
  const hints = [
    "autres",
    "d autres",
    "d autres recettes",
    "plus",
    "plus de recettes",
    "autre",
    "encore",
    "different",
    "differentes",
    "différentes"
  ];
  return hints.some((h) => msg.includes(normalizePlain(h)));
}

function buildRecipeChoices(titles, usedTitles, query, offset, limit) {
  const hasQuery = tokenizeForMatch(query).length > 0;
  let ranked = rankTitlesByQuery(titles, query, usedTitles);
  if (!ranked.length) ranked = rankTitlesByQuery(titles, "", usedTitles);
  if (!hasQuery && ranked.length > 1) {
    ranked = shuffle(ranked);
  }
  if (!ranked.length) return { choices: [], offset: 0, total: 0 };
  const total = ranked.length;
  const start = Math.min(offset || 0, Math.max(total - 1, 0));
  const slice = ranked.slice(start, start + limit);
  if (slice.length < limit && total > slice.length) {
    slice.push(...ranked.slice(0, limit - slice.length));
  }
  const nextOffset = (start + limit) % Math.max(total, 1);
  return { choices: slice, offset: nextOffset, total };
}

function extractSansItem(text) {
  const raw = String(text || "").trim();
  if (!raw) return "";
  const m = raw.match(/\bsans\s+(.+)$/i);
  if (!m || !m[1]) return "";
  return String(m[1]).trim();
}

function removeItemFromTitle(title, itemRaw) {
  const titleStr = String(title || "").trim();
  const item = normalizePlain(itemRaw).trim();
  if (!titleStr || !item) return titleStr;

  const words = item.split(" ").filter(Boolean);
  if (words.length === 0) return titleStr;
  const pattern = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\W+");
  const re = new RegExp(`\\s*(,|et|avec|&)?\\s*${pattern}\\b`, "i");
  const next = titleStr.replace(re, "").replace(/\s{2,}/g, " ").trim();
  return next.replace(/\s*[,;–—-]\s*$/, "").trim();
}

function inferReplaceSourceFromTitle(title) {
  const t = String(title || "").trim().toLowerCase();
  if (!t) return "CHAT_USER";
  if (t.startsWith("remplace ") || t.startsWith("remplacer ")) return "CHAT_EDIT";
  return "CHAT_USER";
}

function detectReplaceProposal(message) {
  const raw = String(message || "").trim();
  if (!raw) return null;
  const msg = normalizePlain(raw);
  if (!msg) return null;

  const dayMap = {
    lundi: "mon",
    mardi: "tue",
    mercredi: "wed",
    jeudi: "thu",
    vendredi: "fri",
    samedi: "sat",
    dimanche: "sun"
  };
  const lunchHints = ["dejeuner", "midi"];
  const dinnerHints = ["diner", "soir"];

  let day = null;
  for (const [label, prefix] of Object.entries(dayMap)) {
    if (msg.includes(label)) {
      day = prefix;
      break;
    }
  }
  if (!day) return null;

  const isLunch = lunchHints.some((h) => msg.includes(h));
  const isDinner = dinnerHints.some((h) => msg.includes(h));
  if ((isLunch && isDinner) || (!isLunch && !isDinner)) return null;
  const slot = `${day}_${isLunch ? "lunch" : "dinner"}`;
  if (!SLOT_LABELS[slot]) return null;

  let title = "";
  const lower = raw.toLowerCase();
  const setPhrase = ["ce sera", "ça sera", "c est", "c'est", "sera"];
  let idx = -1;
  for (const p of setPhrase) {
    const i = lower.indexOf(p);
    if (i !== -1) {
      idx = i + p.length;
      break;
    }
  }
  if (idx === -1) {
    const wantPhrases = [
      "je veux que ce soit",
      "je veux",
      "je voudrais",
      "je souhaite",
      "j'aimerais",
      "je prends"
    ];
    for (const p of wantPhrases) {
      const i = lower.indexOf(p);
      if (i !== -1) {
        idx = i + p.length;
        break;
      }
    }
  }
  if (idx !== -1) {
    title = raw.slice(idx).trim();
  }
  if (!title) {
    const m = raw.match(/[:=]\s*(.+)$/);
    if (m) title = String(m[1] || "").trim();
  }
  if (!title) {
    const m = raw.match(/[-–—]\s*(.+)$/);
    if (m) title = String(m[1] || "").trim();
  }
  if (!title) return null;

  title = title.replace(/^["'«»]+|["'«»]+$/g, "").trim();
  const sansItem = extractSansItem(title);
  title = stripSansClause(title);
  if (sansItem) {
    title = removeItemFromTitle(title, sansItem);
  }
  if (!title) return null;

  const source = inferReplaceSourceFromTitle(title);
  return { slot, title, source };
}

function stripSansClause(title) {
  if (!title) return "";
  const cleaned = String(title)
    .replace(/\s+(sans)\s+.+$/i, "")
    .replace(/\s*[,;–—-]\s*$/g, "")
    .trim();
  return cleaned;
}

function parseProposalLines(
  lines,
  slots,
  existingTitles = null,
  existingKeys = null,
  opts = {}
) {
  const slotSet = new Set(slots);
  const titles = new Set();
  const keys = new Set();
  const map = new Map();

  for (const line of lines) {
    const m = line.match(/^[-*]\s*([a-z_]+)\s*:\s*(.+)$/i);
    if (!m) continue;
    const slot = normalizeSlotKey(m[1]);
    const title = normalizeTitle(m[2]);
    if (!slot || !title) continue;
    if (isLeftoverTitle(title)) continue;
    if (!slotSet.has(slot)) continue;
    if (map.has(slot)) continue;
    const key = title.toLowerCase();
    const tKey = titleKey(title);
    if (titles.has(key)) continue;
    if (tKey && keys.has(tKey)) continue;
    if (existingTitles && existingTitles.has(key)) continue;
    if (existingKeys && tKey && existingKeys.has(tKey)) continue;
    const ingKey = opts.ingredientKeyFn ? opts.ingredientKeyFn(title) : "";
    if (opts.isIngredientAllowed && ingKey && !opts.isIngredientAllowed(ingKey, slot)) continue;
    map.set(slot, title);
    titles.add(key);
    if (tKey) keys.add(tKey);
    if (ingKey && opts.onIngredientUsed) opts.onIngredientUsed(ingKey, slot);
  }

  return { map, titles, keys };
}

function normalizeDriveTitle(raw) {
  const t = String(raw || "").trim();
  if (!t) return "";
  return t.replace(/\.pdf$/i, "").trim();
}

async function listDriveIndexTitles() {
  const csvCandidates = [
    path.join(PROJECT_ROOT, "recipes_list.csv"),
    path.join(path.resolve(PROJECT_ROOT, ".."), "recipes_list.csv")
  ];
  for (const csvPath of csvCandidates) {
    if (!fsSync.existsSync(csvPath)) continue;
    const raw = fsSync.readFileSync(csvPath, "utf8");
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length <= 1) continue;
    const titles = [];
    for (let i = 1; i < lines.length; i += 1) {
      const parts = lines[i].split(";");
      const title = normalizeDriveTitle(parts[0] || "");
      if (title) titles.push(title);
    }
    if (titles.length) return titles;
  }

  const jsonCandidates = [
    path.join(PROJECT_ROOT, "recettes_index.json"),
    path.join(path.resolve(PROJECT_ROOT, ".."), "recettes_index.json")
  ];
  for (const jsonPath of jsonCandidates) {
    if (!fsSync.existsSync(jsonPath)) continue;
    try {
      const raw = fsSync.readFileSync(jsonPath, "utf8");
      const data = JSON.parse(raw);
      if (!Array.isArray(data)) continue;
      const titles = data
        .map((item) => normalizeDriveTitle(item?.title || ""))
        .filter(Boolean);
      if (titles.length) return titles;
    } catch {
      // ignore invalid JSON
    }
  }

  return [];
}

function newProposalId() {
  return `p_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function peopleSignature(people) {
  const adults = Number.isFinite(people?.adults) ? people.adults : 0;
  const children = Number.isFinite(people?.children) ? people.children : 0;
  const months = Array.isArray(people?.child_birth_months)
    ? people.child_birth_months.join(",")
    : "";
  return `${adults}|${children}|${months}`;
}

async function buildPreviewFromTitle(title, people) {
  const openai = getOpenAIClient();
  if (!openai) {
    const err = new Error("openai_not_configured");
    err.code = "openai_not_configured";
    throw err;
  }

  const model = getCheapModel();
  const peopleLine = people
    ? `Personnes: ${people.adults || 0} adulte(s), ${people.children || 0} enfant(s) (${(people.child_birth_months || []).join(", ") || "n/a"}).`
    : "";

  const previewSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      description_courte: { type: "string" },
      ingredients: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            item: { type: "string" },
            qty: { type: "string" },
            unit: { type: "string" }
          },
          required: ["item", "qty", "unit"]
        }
      },
      preparation_steps: {
        type: "array",
        items: { type: "string" }
      }
    },
    required: ["description_courte", "ingredients", "preparation_steps"]
  };

  const prompt = [
    `Génère une fiche courte de recette pour : "${title}".`,
    peopleLine,
    "Réponds STRICTEMENT en JSON avec ces clés:",
    '{"description_courte":"...", "ingredients":[{"item":"...","qty":"...","unit":"..."}], "preparation_steps":["...","..."]}',
    "IMPORTANT: preparation_steps doit contenir au moins 3 étapes."
  ].join("\n");

  const resp = await openai.responses.create({
    model,
    input: prompt,
    text: {
      format: {
        type: "json_schema",
        name: "recipe_preview",
        strict: true,
        schema: previewSchema
      }
    }
  });

  const raw = resp.output_text || "";
  try {
    return JSON.parse(raw);
  } catch (_e) {
    const match = raw.match(/\{[\s\S]*\}/);
    if (match) {
      try {
        return JSON.parse(match[0]);
      } catch {}
    }
    const err = new Error("preview_parse_failed");
    err.code = "preview_parse_failed";
    err.raw_text = raw;
    throw err;
  }
}

async function ensureChatFile(weekId) {
  await ensureDir(CHAT_DIR);

  const p = chatPath(weekId);
  try {
    const data = await readJson(p);

    if (!data.menu_proposals || typeof data.menu_proposals !== "object") {
      data.menu_proposals = {};
    }

    return { path: p, data };
  } catch (e) {
    if (e?.code !== "ENOENT" && e?.code !== "EMPTY_JSON") throw e;

    const fresh = {
      week_id: weekId,
      messages: [],
      menu_proposals: {},
      usage_totals: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0
      },
      usage_by_model: {},
      updated_at: nowIso()
    };
    if (CHAT_PERSIST) {
      await writeJson(p, fresh);
    }
    return { path: p, data: fresh };
  }
}

async function safeWriteChat(filePath, data) {
  if (!CHAT_PERSIST) return;
  await writeJson(filePath, data);
}

function addUsage(session, model, usage) {
  if (!usage) return;

  const input = Number(usage.input_tokens || 0);
  const output = Number(usage.output_tokens || 0);
  const total = usage.total_tokens != null ? usage.total_tokens : input + output;

  session.usage_totals.input_tokens += input;
  session.usage_totals.output_tokens += output;
  session.usage_totals.total_tokens += total;

  if (!session.usage_by_model[model]) {
    session.usage_by_model[model] = {
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0
    };
  }

  session.usage_by_model[model].input_tokens += input;
  session.usage_by_model[model].output_tokens += output;
  session.usage_by_model[model].total_tokens += total;
}

// ---------- Routes ----------

/**
 * GET /api/chat/current?week_id=2026-W02
 */
router.get("/current", async (req, res) => {
  const weekId = String(req.query.week_id || "");
  if (!weekId) return res.status(400).json({ error: "missing_week_id" });

  try {
    const { data } = await ensureChatFile(weekId);
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: "chat_read_failed", details: e.message });
  }
});

/**
 * POST /api/chat/current
 */
router.post("/current", async (req, res) => {
  const weekId = String(req.body?.week_id || "");
  const message = String(req.body?.message || "");
  const context = req.body?.context || null;

  if (!weekId) return res.status(400).json({ error: "missing_week_id" });
  if (!message.trim())
    return res.status(400).json({ error: "missing_message" });

  try {
    const { path: p, data } = await ensureChatFile(weekId);

    data.messages.push({
      role: "user",
      content: message,
      context,
      created_at: nowIso()
    });

    let assistantText = "";
    let usage = null;
    let warning = null;

    let openai = getOpenAIClient();
    const model = getCheapModel();

    if (openai) {
      try {
        const systemLines = [
          "Tu es l'assistant du cockpit menus.",
          ...buildStaticConstraintsPromptLines(),
          "Reponds en francais, court, actionnable."
        ];
        const system = {
          role: "system",
          content: systemLines.filter(Boolean).join("\n")
        };

        const history = data.messages
          .slice(-20)
          .map((m) => ({ role: m.role, content: m.content }));

        const resp = await openai.responses.create({
          model,
          input: [system, ...history]
        });

        assistantText = resp.output_text || "(aucune reponse)";
        usage = resp.usage || null;
      } catch (e) {
        assistantText = e?.message || "OpenAI error";
        warning = "openai_error";
      }
    } else {
      assistantText = "OpenAI non configure.";
      warning = "openai_not_configured";
    }

    data.messages.push({
      role: "assistant",
      content: assistantText,
      context,
      created_at: nowIso(),
      usage: usage || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
      model
    });

    addUsage(data, model, usage);

    data.updated_at = nowIso();
    await safeWriteChat(p, data);

    res.json({ ...data, ...(warning ? { warning } : {}) });
  } catch (e) {
    res.status(500).json({ error: "chat_write_failed", details: e.message });
  }
});

/**
 * GET /api/chat/proposals?week_id=2026-W04
 */
router.get("/proposals", async (req, res) => {
  const weekId = String(req.query.week_id || "");
  if (!weekId) return res.status(400).json({ error: "missing_week_id" });

  try {
    const { data } = await ensureChatFile(weekId);
    res.json({ week_id: weekId, menu_proposals: data.menu_proposals || {} });
  } catch (e) {
    res.status(500).json({ error: "proposals_read_failed", details: e.message });
  }
});

/**
 * POST /api/chat/proposals/import
 */
router.post("/proposals/import", async (req, res) => {
  const weekId = String(req.body?.week_id || "");
  const proposals = req.body?.proposals || null;

  if (!weekId) return res.status(400).json({ error: "missing_week_id" });
  if (!proposals || typeof proposals !== "object") {
    return res.status(400).json({ error: "missing_proposals" });
  }

  try {
    const { path: p, data } = await ensureChatFile(weekId);
    if (!data.menu_proposals || typeof data.menu_proposals !== "object") {
      data.menu_proposals = {};
    }

    const createdAt = nowIso();
    const usedTitles = new Set();

    for (const [slotRaw, listRaw] of Object.entries(proposals)) {
      const slot = normalizeSlotKey(slotRaw);
      if (!slot) continue;

      const list = Array.isArray(listRaw) ? listRaw : [];
      if (!data.menu_proposals[slot]) data.menu_proposals[slot] = [];

      for (const item of list) {
        const title =
          typeof item === "string"
            ? normalizeTitle(item)
            : normalizeTitle(item?.title);

        if (!title) continue;

        data.menu_proposals[slot].push({
          proposal_id: newProposalId(),
          title,
          source: "CHAT_IMPORT",
          status: "PROPOSED",
          to_save: false,
          created_at: createdAt
        });
      }
    }

    data.updated_at = nowIso();
    await safeWriteChat(p, data);

    res.json({ ok: true, week_id: weekId, menu_proposals: data.menu_proposals });
  } catch (e) {
    res.status(500).json({ error: "proposals_import_failed", details: e.message });
  }
});

/**
 * POST /api/chat/proposals/generate
 * body: { week_id, slots, overwrite }
 */
router.post("/proposals/generate", async (req, res) => {
    const weekId = String(req.body?.week_id || "");
    const slots = Array.isArray(req.body?.slots) ? req.body.slots : [];
    const overwrite = !!req.body?.overwrite;

  if (!weekId) return res.status(400).json({ error: "missing_week_id" });
  if (slots.length === 0) {
    return res.status(400).json({ error: "missing_slots" });
  }

  try {
    const { path: p, data } = await ensureChatFile(weekId);
    const nextData = JSON.parse(JSON.stringify(data || {}));
    if (!nextData.menu_proposals || typeof nextData.menu_proposals !== "object") {
      nextData.menu_proposals = {};
    }

    const openai = getOpenAIClient();
    const model = getMenuGenerateModel();
    const aiMaxSlots = getMenuGenerateAiMaxSlots();
    const aiAttempts = getMenuGenerateAttempts();

    const weekData = await readJson(path.join(DATA_DIR, "weeks", `${weekId}.json`)).catch(
      () => null
    );
    const noLunchSlots = new Set(
      weekData?.rules_readonly?.no_lunch_slots || ["mon_lunch", "tue_lunch", "thu_lunch", "fri_lunch"]
    );
    const filteredSlots = slots.filter((s) => !noLunchSlots.has(s));
    if (filteredSlots.length === 0) {
      return res.status(400).json({ error: "no_eligible_slots" });
    }
    const slotsSet = new Set(filteredSlots);
    if (overwrite) {
      for (const slot of filteredSlots) {
        nextData.menu_proposals[slot] = [];
      }
    }

    const previousTitlesBySlot = {};
    for (const slot of filteredSlots) {
      const list = nextData.menu_proposals?.[slot] || [];
      previousTitlesBySlot[slot] = list
        .map((p) => String(p?.title || "").trim())
        .filter(Boolean);
    }

    const avoidLines = filteredSlots
      .map((s) => {
        const titles = previousTitlesBySlot[s] || [];
        if (titles.length === 0) return null;
        return `Ne propose pas pour ${s}: ${titles.join(" | ")}`;
      })
      .filter(Boolean);

    const usedTitlesForPrompt = Array.from(
      Object.entries(nextData.menu_proposals || {})
        .filter(([slot]) => !slotsSet.has(slot))
        .flatMap(([, list]) => list || [])
        .map((p) => String(p?.title || "").trim())
        .filter(Boolean)
    );
    const avoidGlobalLine =
      usedTitlesForPrompt.length > 0
        ? `Ne propose pas ces titres (déjà utilisés cette semaine): ${usedTitlesForPrompt.join(
            " | "
          )}`
        : null;

    const historyIngredientKeys = await collectHistoricalIngredientKeys(
      weekId,
      Number.isFinite(HISTORY_WEEKS_LIMIT) ? HISTORY_WEEKS_LIMIT : 0
    );
    const maxIngredientPerWeek = Number(
      weekData?.rules_readonly?.main_ingredient_max_per_week || 2
    );
    const minDaysBetweenRepeat = Number(
      weekData?.rules_readonly?.main_ingredient_min_day_gap_if_used_twice ??
        weekData?.rules_readonly?.min_days_between_repeat ??
        2
    );
    const ingredientUsage = new Map();
    const ingredientDisallowed = new Set(historyIngredientKeys);

    const getUsage = (key) => {
      if (!ingredientUsage.has(key)) {
        ingredientUsage.set(key, { count: 0, days: [] });
      }
      return ingredientUsage.get(key);
    };
    const markIngredientUsed = (key, slot) => {
      if (!key) return;
      const usage = getUsage(key);
      usage.count += 1;
      const day = slotDayIndex(slot);
      if (day != null) usage.days.push(day);
    };
    const isIngredientAllowed = (key, slot) => {
      if (!key) return true;
      if (ingredientDisallowed.has(key)) return false;
      const usage = ingredientUsage.get(key);
      const count = usage?.count || 0;
      const day = slotDayIndex(slot);
      const alreadyUsedDay = day != null && usage?.days?.includes(day);
      if (!alreadyUsedDay && count >= maxIngredientPerWeek) return false;
      if (
        !alreadyUsedDay &&
        Number.isFinite(minDaysBetweenRepeat) &&
        minDaysBetweenRepeat > 0 &&
        day != null
      ) {
        for (const usedDay of usage?.days || []) {
          if (Math.abs(day - usedDay) < minDaysBetweenRepeat) return false;
        }
      }
      return true;
    };

    const recipeCache = new Map();
    const currentWeekTitles = [];
    const weekSlots = weekData?.slots || {};
    for (const [slot, slotData] of Object.entries(weekSlots)) {
      const free = String(slotData?.free_text || "").trim();
      let title = free;
      if (!title) {
        const recipeId = String(slotData?.recipe_id || "").trim();
        if (recipeId) {
          title = await readRecipeTitleById(recipeId, recipeCache);
        }
      }
      if (!title) continue;
      currentWeekTitles.push(title);
      const k = mainIngredientKeyFromTitle(title);
      if (k) markIngredientUsed(k, slot);
    }

    for (const [slot, listRaw] of Object.entries(nextData.menu_proposals || {})) {
      if (overwrite && slotsSet.has(slot)) continue;
      const list = Array.isArray(listRaw) ? listRaw : [];
      const firstTitle = String(list?.[0]?.title || "").trim();
      if (!firstTitle) continue;
      const k = mainIngredientKeyFromTitle(firstTitle);
      if (!k) continue;
      markIngredientUsed(k, slot);
    }

    const avoidIngredients = Array.from(
      new Set([
        ...Array.from(ingredientDisallowed.values()),
        ...Array.from(ingredientUsage.keys())
      ])
    );
    const avoidIngredientLine =
      avoidIngredients.length > 0
        ? `Évite de proposer des plats avec ces ingrédients principaux (déjà utilisés cette semaine ou récemment): ${avoidIngredients
            .slice(0, 12)
            .map((k) => mainIngredientLabel(k))
            .join(", ")}`
        : null;

    let rawText = "";
    let lines = [];
    let parsedMap = null;
    let openaiAvailable = !!openai;
    let sourceType = openaiAvailable ? "CHAT_GENERATED" : "CHAT_GENERATED";
    const sourceBySlot = {};

    const usedTitlesForUniq = new Set(
      Object.entries(nextData.menu_proposals || {})
        .flatMap(([, list]) => list || [])
        .map((p) => String(p?.title || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const usedKeysForUniq = new Set(
      Object.entries(nextData.menu_proposals || {})
        .flatMap(([, list]) => list || [])
        .map((p) => titleKey(String(p?.title || "").trim()))
        .filter(Boolean)
    );

    for (const t of currentWeekTitles) {
      const key = String(t || "").trim();
      if (!key) continue;
      usedTitlesForUniq.add(key.toLowerCase());
      const tKey = titleKey(key);
      if (tKey) usedKeysForUniq.add(tKey);
    }

    const avoidTitlesForPrompt = [];
    const seenAvoid = new Set();
    for (const t of currentWeekTitles) {
      const norm = String(t || "").trim();
      if (!norm) continue;
      const low = norm.toLowerCase();
      if (seenAvoid.has(low)) continue;
      seenAvoid.add(low);
      avoidTitlesForPrompt.push(norm);
    }
    for (const listRaw of Object.values(nextData.menu_proposals || {})) {
      const list = Array.isArray(listRaw) ? listRaw : [];
      for (const p of list) {
        const t = String(p?.title || "").trim();
        if (!t) continue;
        const low = t.toLowerCase();
        if (seenAvoid.has(low)) continue;
        seenAvoid.add(low);
        avoidTitlesForPrompt.push(t);
      }
    }
    const avoidTitleLine =
      avoidTitlesForPrompt.length > 0
        ? `Titres déjà proposés cette semaine (à éviter si possible): ${avoidTitlesForPrompt
            .slice(0, 8)
            .join(" | ")}`
        : null;

    const driveTitles = await listDriveIndexTitles();
    const driveCandidates = shuffle(
      driveTitles.filter((t) => {
        const key = t.toLowerCase();
        const tKey = titleKey(t);
        const iKey = mainIngredientKeyFromTitle(t);
        if (isLeftoverTitle(t)) return false;
        if (iKey && !isIngredientAllowed(iKey, null)) return false;
        return key && !usedTitlesForUniq.has(key) && (!tKey || !usedKeysForUniq.has(tKey));
      })
    );

    const slotCount = filteredSlots.length;
    const aiTargetSlots = Math.min(slotCount, aiMaxSlots);
    const minAI = 0;
    const maxAI = aiTargetSlots;
    const ratioWarning = null;
    let ratioRelaxed = false;

    if (driveCandidates.length > 0) {
      const driveMap = new Map();
      for (const slot of filteredSlots) {
        if (driveCandidates.length === 0) break;
        const title = driveCandidates.shift();
        if (isLeftoverTitle(title)) continue;
        const key = title.toLowerCase();
        const tKey = titleKey(title);
        const iKey = mainIngredientKeyFromTitle(title);
        if (iKey && !isIngredientAllowed(iKey, slot)) continue;
        if (usedTitlesForUniq.has(key)) continue;
        if (tKey && usedKeysForUniq.has(tKey)) continue;
        driveMap.set(slot, title);
        usedTitlesForUniq.add(key);
        if (tKey) usedKeysForUniq.add(tKey);
        if (iKey) markIngredientUsed(iKey, slot);
        sourceBySlot[slot] = "DRIVE_INDEX";
      }
      if (driveMap.size > 0) {
        parsedMap = driveMap;
      }
    }

    const remainingSlotsInitial = filteredSlots.filter((s) => !parsedMap?.has(s));
    const remainingSlotsForAi =
      aiTargetSlots > 0 ? remainingSlotsInitial.slice(0, aiTargetSlots) : [];
    if (remainingSlotsForAi.length > 0 && !openaiAvailable) {
      return res.status(500).json({ error: "openai_not_configured" });
    }

    if (openaiAvailable && remainingSlotsForAi.length > 0) {
      try {
        let attempts = 0;
        while (attempts < aiAttempts) {
          attempts += 1;
          const remainingSlots = remainingSlotsForAi.filter((s) => !parsedMap?.has(s));
          if (remainingSlots.length === 0) break;
          const constraints = await readConstraints();
          const globalConstraints = constraints.global || [];
          const weekConstraints = constraints.weeks?.[weekId] || [];
          const constraintLine =
            globalConstraints.length || weekConstraints.length
              ? `Contraintes utilisateur: ${[...globalConstraints, ...weekConstraints].join(" | ")}`
              : "Contraintes utilisateur: aucune.";
          const staticConstraintsLines = buildStaticConstraintsPromptSummaryLines();
          const assumptions =
            "Contexte: France (hémisphère Nord). Date de référence: 25 janvier 2026.";
          const resp = await openai.responses.create({
            model,
            input: [
              "Tu proposes des idées de plats pour un menu hebdomadaire (brouillon).",
              "Règles PRIORITAIRES:",
              "1) Format: une ligne par slot, format strict: '- slot: <titre>'.",
              "2) Aucune recette/ingrédient/liste de courses avant validation du tableau.",
              "3) Si ambiguïté/information manquante: fais une hypothèse raisonnable et continue.",
              "4) Respecter les contraintes Accueil (ci-dessous).",
              ...staticConstraintsLines,
              constraintLine,
              assumptions,
              "Donne un menu au format strict suivant (une ligne par slot):",
              ...remainingSlots.map((s) => `- ${s}: <titre>`),
              ...avoidLines,
              ...(avoidTitleLine ? [avoidTitleLine] : []),
              ...(avoidGlobalLine ? [avoidGlobalLine] : []),
              ...(avoidIngredientLine ? [avoidIngredientLine] : []),
              "Aucun texte en plus."
            ].join("\n")
          });
          rawText = resp.output_text || "";
          if (rawText.trim().startsWith("QUESTION:")) {
            // Retry once with explicit assumptions (already included) and continue loop.
            rawText = "";
            lines = [];
            continue;
          }
          lines = rawText.split("\n").map((l) => l.trim()).filter(Boolean);
          const usageSnapshot = new Map(
            Array.from(ingredientUsage.entries()).map(([k, v]) => [
              k,
              { count: v.count, days: [...v.days] }
            ])
          );
          const parsed = parseProposalLines(lines, remainingSlots, usedTitlesForUniq, usedKeysForUniq, {
            ingredientKeyFn: mainIngredientKeyFromTitle,
            isIngredientAllowed,
            onIngredientUsed: markIngredientUsed
          });
          if (parsed.map.size > 0) {
            parsedMap = parsedMap || new Map();
            for (const [slot, title] of parsed.map.entries()) {
              parsedMap.set(slot, title);
              sourceBySlot[slot] = "CHAT_GENERATED";
              usedTitlesForUniq.add(title.toLowerCase());
              const tKey = titleKey(title);
              if (tKey) usedKeysForUniq.add(tKey);
            }
            if (parsed.map.size === remainingSlots.length) break;
          }
          ingredientUsage.clear();
          for (const [k, v] of usageSnapshot.entries()) {
            ingredientUsage.set(k, v);
          }
          rawText = "";
          lines = [];
        }
      } catch (e) {
        console.warn("[proposals/generate] openai error", {
          weekId,
          message: e?.message || String(e)
        });
        openaiAvailable = false;
        openai = null;
        sourceType = "CHAT_GENERATED";
        rawText = "";
        lines = [];
      }
    }

    const takeDriveCandidate = (slot) => {
      while (driveCandidates.length > 0) {
        const title = driveCandidates.shift();
        if (!title) continue;
        if (isLeftoverTitle(title)) continue;
        const key = title.toLowerCase();
        const tKey = titleKey(title);
        if (usedTitlesForUniq.has(key)) continue;
        if (tKey && usedKeysForUniq.has(tKey)) continue;
        const iKey = mainIngredientKeyFromTitle(title);
        if (iKey && !isIngredientAllowed(iKey, slot)) continue;
        return { title, key, tKey, iKey };
      }
      return null;
    };

    if (!parsedMap || parsedMap.size !== filteredSlots.length) {
      // Fallback: fill remaining slots from Drive if AI fails or output is incomplete.
      parsedMap = parsedMap || new Map();
      const missingSlots = filteredSlots.filter((s) => !parsedMap.has(s));
      for (const slot of missingSlots) {
        const picked = takeDriveCandidate(slot);
        if (!picked) break;
        parsedMap.set(slot, picked.title);
        sourceBySlot[slot] = "DRIVE_INDEX";
        usedTitlesForUniq.add(picked.key);
        if (picked.tKey) usedKeysForUniq.add(picked.tKey);
        if (picked.iKey) markIngredientUsed(picked.iKey, slot);
      }
    }

    if (aiMaxSlots === 0 && parsedMap && parsedMap.size !== filteredSlots.length) {
      const fallbackTitles = shuffle(
        driveTitles.filter((t) => t && !isLeftoverTitle(t))
      );
      const missingSlots = filteredSlots.filter((s) => !parsedMap.has(s));
      let idx = 0;
      for (const slot of missingSlots) {
        if (fallbackTitles.length === 0) break;
        const title = fallbackTitles[idx % fallbackTitles.length];
        idx += 1;
        if (!title) continue;
        parsedMap.set(slot, title);
        sourceBySlot[slot] = "DRIVE_INDEX";
      }
    }

    if (!parsedMap || parsedMap.size !== filteredSlots.length) {
      if (rawText) {
        console.warn("[proposals/generate] ai_generate_failed", {
          weekId,
          slots: filteredSlots,
          raw_text_preview: String(rawText).slice(0, 1200)
        });
      }
      return res.status(500).json({ error: "ai_generate_failed", raw_text: rawText });
    }

    const createdAt = nowIso();
    const usedTitles = new Set(
      Object.entries(nextData.menu_proposals || {})
        .filter(([slot]) => (overwrite ? !slotsSet.has(slot) : true))
        .flatMap(([, list]) => list || [])
        .map((p) => String(p?.title || "").trim().toLowerCase())
        .filter(Boolean)
    );
    const usedTitleKeys = new Set(
      Object.entries(nextData.menu_proposals || {})
        .filter(([slot]) => (overwrite ? !slotsSet.has(slot) : true))
        .flatMap(([, list]) => list || [])
        .map((p) => titleKey(String(p?.title || "").trim()))
        .filter(Boolean)
    );

    for (const slot of filteredSlots) {
      const title = parsedMap?.get(slot);
      if (!title) continue;
      if (!nextData.menu_proposals[slot]) {
        nextData.menu_proposals[slot] = [];
      }

      const titleLower = title.toLowerCase();
      const tKey = titleKey(title);
      const iKey = mainIngredientKeyFromTitle(title);
      if (iKey && !isIngredientAllowed(iKey, slot)) continue;
      if (usedTitles.has(titleLower)) continue;
      if (tKey && usedTitleKeys.has(tKey)) continue;

      nextData.menu_proposals[slot].push({
        proposal_id: newProposalId(),
        title,
        recipe_id: null,
        source: sourceBySlot[slot] || sourceType,
        status: "PROPOSED",
        to_save: false,
        created_at: createdAt
      });
      usedTitles.add(titleLower);
      if (tKey) usedTitleKeys.add(tKey);
    }

    // Enforce zero-duplicate titles across all requested slots
    const seenTitles = new Set();
    for (const slot of filteredSlots) {
      const list = Array.isArray(nextData.menu_proposals?.[slot])
        ? nextData.menu_proposals[slot]
        : [];
      const unique = [];
      for (const p of list) {
        const key = String(p?.title || "").trim().toLowerCase();
        const tKey = titleKey(String(p?.title || "").trim());
        if (!key || seenTitles.has(key)) continue;
        if (tKey && seenTitles.has(`k:${tKey}`)) continue;
        seenTitles.add(key);
        if (tKey) seenTitles.add(`k:${tKey}`);
        unique.push(p);
      }
      nextData.menu_proposals[slot] = unique;
    }

    // If any slot ended up empty (e.g. duplicates removed), fill with Drive titles.
    const takenTitles = new Set();
    const takenKeys = new Set();
    for (const listRaw of Object.values(nextData.menu_proposals || {})) {
      const list = Array.isArray(listRaw) ? listRaw : [];
      for (const p of list) {
        const key = String(p?.title || "").trim().toLowerCase();
        if (key) takenTitles.add(key);
        const tKey = titleKey(String(p?.title || "").trim());
        if (tKey) takenKeys.add(tKey);
      }
    }
    const pickDriveCandidate = (slot) => {
      while (driveCandidates.length > 0) {
        const title = driveCandidates.shift();
        if (!title) continue;
        if (isLeftoverTitle(title)) continue;
        const key = title.toLowerCase();
        const tKey = titleKey(title);
        if (takenTitles.has(key)) continue;
        if (tKey && takenKeys.has(tKey)) continue;
        const iKey = mainIngredientKeyFromTitle(title);
        if (iKey && !isIngredientAllowed(iKey, slot)) continue;
        return { title, key, tKey, iKey };
      }
      return null;
    };
    let filledFromDrive = 0;
    for (const slot of filteredSlots) {
      const list = Array.isArray(nextData.menu_proposals?.[slot])
        ? nextData.menu_proposals[slot]
        : [];
      if (list.length > 0) continue;
      const picked = pickDriveCandidate(slot);
      if (!picked) break;
      nextData.menu_proposals[slot] = [
        {
          proposal_id: newProposalId(),
          title: picked.title,
          recipe_id: null,
          source: "DRIVE_INDEX",
          status: "PROPOSED",
          to_save: false,
          created_at: createdAt
        }
      ];
      sourceBySlot[slot] = "DRIVE_INDEX";
      takenTitles.add(picked.key);
      if (picked.tKey) takenKeys.add(picked.tKey);
      if (picked.iKey) markIngredientUsed(picked.iKey, slot);
      filledFromDrive += 1;
    }
    if (filledFromDrive > 0) {
      ratioRelaxed = true;
    }

    const aiCount = filteredSlots.filter((s) => sourceBySlot[s] === "CHAT_GENERATED").length;
    const driveCount = filteredSlots.filter((s) => sourceBySlot[s] === "DRIVE_INDEX").length;
    if (aiCount < minAI) {
      if (ratioRelaxed) {
        console.warn("[proposals/generate] ai_ratio_too_low_relaxed", {
          weekId,
          aiCount,
          driveCount,
          minAI,
          maxAI,
          filledFromDrive
        });
      } else if (rawText) {
        console.warn("[proposals/generate] ai_ratio_too_low", {
          weekId,
          aiCount,
          driveCount,
          minAI,
          maxAI,
          raw_text_preview: String(rawText).slice(0, 1200)
        });
      } else {
        console.warn("[proposals/generate] ai_ratio_too_low", {
          weekId,
          aiCount,
          driveCount,
          minAI,
          maxAI
        });
      }
      if (!ratioRelaxed) {
        return res.status(409).json({
          error: "ai_ratio_too_low",
          details: { aiCount, driveCount, minAI, maxAI }
        });
      }
    }
    if (aiCount > maxAI && !ratioWarning) {
      return res.status(409).json({
        error: "ai_ratio_too_high",
        details: { aiCount, driveCount, minAI, maxAI }
      });
    }

    // Final global de-duplication across all slots (including existing ones)
    const orderedSlots = [
      ...filteredSlots,
      ...Object.keys(nextData.menu_proposals || {}).filter((s) => !slotsSet.has(s))
    ];
    const seenGlobal = new Set();
    for (const slot of orderedSlots) {
      const list = Array.isArray(nextData.menu_proposals?.[slot])
        ? nextData.menu_proposals[slot]
        : [];
      const unique = [];
      for (const p of list) {
        const key = String(p?.title || "").trim().toLowerCase();
        const tKey = titleKey(String(p?.title || "").trim());
        if (!key || seenGlobal.has(key)) continue;
        if (tKey && seenGlobal.has(`k:${tKey}`)) continue;
        seenGlobal.add(key);
        if (tKey) seenGlobal.add(`k:${tKey}`);
        unique.push(p);
      }
      nextData.menu_proposals[slot] = unique;
    }

    nextData.updated_at = nowIso();
    await safeWriteChat(p, nextData);

    res.json({
      ok: true,
      week_id: weekId,
      menu_proposals: nextData.menu_proposals,
      raw_text: rawText,
      ratio: {
        ai_count: filteredSlots.filter((s) => sourceBySlot[s] === "CHAT_GENERATED").length,
        drive_count: filteredSlots.filter((s) => sourceBySlot[s] === "DRIVE_INDEX").length,
        min_ai: minAI,
        max_ai: maxAI,
        warning: ratioWarning || (ratioRelaxed ? "ai_ratio_relaxed" : null)
      }
    });
  } catch (e) {
    res.status(500).json({ error: "proposals_generate_failed", details: e.message });
  }
});

/**
 * POST /api/chat/proposals/preview
 * body: { week_id, slot, proposal_id, title }
 * Returns preview and stores it on the proposal.
 */
router.post("/proposals/preview", async (req, res) => {
  const weekId = String(req.body?.week_id || "");
  const slot = String(req.body?.slot || "");
  const proposalId = String(req.body?.proposal_id || "");
  const title = String(req.body?.title || "");
  const people = req.body?.people || null;

  if (!weekId) return res.status(400).json({ error: "missing_week_id" });
  if (!slot) return res.status(400).json({ error: "missing_slot" });
  if (!proposalId) return res.status(400).json({ error: "missing_proposal_id" });
  if (!title) return res.status(400).json({ error: "missing_title" });

  try {
    const { path: p, data } = await ensureChatFile(weekId);
    const list = data.menu_proposals?.[slot] || [];
    let idx = list.findIndex((x) => x?.proposal_id === proposalId);
    if (idx === -1 && title) {
      const needle = normalizeKey(title);
      if (needle) {
        idx = list.findIndex((x) => normalizeKey(x?.title || "") === needle);
      }
    }

    const signature = peopleSignature(people);

    // Return cached preview if present and people match
    if (idx !== -1 && list[idx].preview && list[idx].preview_people_signature === signature) {
      return res.json({ ok: true, preview: list[idx].preview, stored: true });
    }

    const preview = await buildPreviewFromTitle(title, people);

    if (idx === -1) {
      return res.json({ ok: true, preview, stored: false, proposal_missing: true });
    }

    list[idx].preview = preview;
    list[idx].preview_people_signature = signature;
    data.menu_proposals[slot] = list;
    data.updated_at = nowIso();
    await safeWriteChat(p, data);

    return res.json({ ok: true, preview, stored: true });
  } catch (e) {
    if (e?.code === "openai_not_configured") {
      return res.status(500).json({ error: "openai_not_configured" });
    }
    if (e?.code === "preview_parse_failed") {
      return res.status(500).json({ error: "preview_parse_failed", raw_text: e.raw_text || "" });
    }
    return res.status(500).json({ error: "preview_failed", details: e.message });
  }
});

/**
 * POST /api/chat/preview-title
 * body: { title, people }
 * Returns preview without storing.
 */
router.post("/preview-title", async (req, res) => {
  const title = String(req.body?.title || "");
  const people = req.body?.people || null;

  if (!title) return res.status(400).json({ error: "missing_title" });

  try {
    const preview = await buildPreviewFromTitle(title, people);
    return res.json({ ok: true, preview, stored: false });
  } catch (e) {
    if (e?.code === "openai_not_configured") {
      return res.status(500).json({ error: "openai_not_configured" });
    }
    if (e?.code === "preview_parse_failed") {
      return res.status(500).json({ error: "preview_parse_failed", raw_text: e.raw_text || "" });
    }
    return res.status(500).json({ error: "preview_failed", details: e.message });
  }
});

/**
 * GET /api/chat/usage?week_id=2026-W02
 */
router.get("/usage", async (req, res) => {
  const weekId = String(req.query.week_id || "");
  if (!weekId) return res.status(400).json({ error: "missing_week_id" });

  try {
    const { data } = await ensureChatFile(weekId);
    res.json({
      week_id: weekId,
      usage_totals: data.usage_totals,
      usage_by_model: data.usage_by_model,
      updated_at: data.updated_at
    });
  } catch (e) {
    res.status(500).json({ error: "usage_read_failed", details: e.message });
  }
});

/**
 * GET /api/chat/usage/all
 */
router.get("/usage/all", async (_req, res) => {
  try {
    await ensureDir(CHAT_DIR);
    const files = await fs.readdir(CHAT_DIR);
    const out = [];

    for (const f of files) {
      if (!f.endsWith(".json")) continue;
      const raw = await readJson(path.join(CHAT_DIR, f));
      out.push({
        week_id: raw.week_id,
        total_tokens: raw.usage_totals?.total_tokens ?? 0,
        usage_totals: raw.usage_totals || { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
        usage_by_model: raw.usage_by_model || {},
        updated_at: raw.updated_at || null
      });
    }

    out.sort((a, b) => a.week_id.localeCompare(b.week_id));
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: "usage_all_failed", details: e.message });
  }
});

// ------------------------------------------------------------------
// Backward compatibility / Tokens aliases
// ------------------------------------------------------------------
const redirectToUsageAll = (_req, res) => {
  res.redirect(302, "/api/chat/usage/all");
};

router.get("", redirectToUsageAll);
router.get("/", redirectToUsageAll);
router.get("/tokens", redirectToUsageAll);
router.get("/usage/tokens", redirectToUsageAll);

// ------------------------------------------------------------------
// Chat commands (Sprint G)
// ------------------------------------------------------------------
/**
 * POST /api/chat/commands/parse
 * body: { week_id, message }
 * Returns a proposed action to validate.
 */
router.post("/commands/parse", async (req, res) => {
  const weekId = String(req.body?.week_id || "");
  const message = String(req.body?.message || "").trim();
  if (!weekId) return res.status(400).json({ error: "missing_week_id" });
  if (!message) return res.status(400).json({ error: "missing_message" });

  try {
    const { path: chatPathFile, data: chatData } = await ensureChatFile(weekId);
    const weekData = await readJson(path.join(DATA_DIR, "weeks", `${weekId}.json`)).catch(
      () => null
    );
    const noLunchSlots = new Set(
      weekData?.rules_readonly?.no_lunch_slots || ["mon_lunch", "tue_lunch", "thu_lunch", "fri_lunch"]
    );
    const slotLines = Object.entries(SLOT_LABELS)
      .filter(([slot]) => !noLunchSlots.has(slot))
      .map(([slot, label]) => `${slot} = ${label}`)
      .join("\n");

    if (chatData?.pending_recipe_target?.title) {
      const slot = detectSlotInMessage(message);
      if (slot) {
        const title = chatData.pending_recipe_target.title;
        delete chatData.pending_recipe_target;
        chatData.updated_at = nowIso();
        await safeWriteChat(chatPathFile, chatData);
        const label = SLOT_LABELS[slot] || slot;
        return res.json({
          ok: true,
          action: {
            action_type: "force_menu_confirm",
            slot,
            title,
            source: "CHAT_USER"
          },
          summary: `Confirme: tu veux "${title}" (${label}) ? (Valider = oui, Refuser = non)`
        });
      }
      return res.json({
        ok: true,
        action: null,
        summary: `Pour quel repas veux-tu "${chatData.pending_recipe_target.title}" ?`
      });
    }

    if (chatData?.pending_recipe_choices?.choices?.length) {
      const pending = chatData.pending_recipe_choices;
      const choices = pending.choices;
      const msg = String(message || "").trim();

      const explicitTitle =
        detectTitleForSlot(message)?.title || detectRecipeForSlot(message)?.title;
      const explicitSlot =
        detectTitleForSlot(message)?.slot || detectRecipeForSlot(message)?.slot || null;
      if (explicitTitle) {
        delete chatData.pending_recipe_choices;
        chatData.updated_at = nowIso();
        await safeWriteChat(chatPathFile, chatData);
        if (explicitSlot) {
          const label = SLOT_LABELS[explicitSlot] || explicitSlot;
          return res.json({
            ok: true,
            action: {
              action_type: "force_menu_confirm",
              slot: explicitSlot,
              title: explicitTitle,
              source: "CHAT_USER"
            },
            summary: `Confirme: tu veux "${explicitTitle}" (${label}) ? (Valider = oui, Refuser = non)`
          });
        }
        chatData.pending_recipe_target = { title: explicitTitle, created_at: nowIso() };
        chatData.updated_at = nowIso();
        await safeWriteChat(chatPathFile, chatData);
        return res.json({
          ok: true,
          action: null,
          summary: `Tu choisis "${explicitTitle}". Pour quel repas veux-tu l'utiliser ?`
        });
      }

      const suggestionRequest = detectRecipeSuggestionRequest(message);
      const wantsMore = wantsMoreRecipes(message);
      if (suggestionRequest || wantsMore) {
        const slot = suggestionRequest?.slot ?? pending.slot ?? null;
        const query =
          suggestionRequest?.query != null && suggestionRequest.query !== ""
            ? suggestionRequest.query
            : pending.query || "";
        const driveTitles = await listDriveIndexTitles();
        const usedTitles = await collectUsedTitlesForWeek(weekData, chatData.menu_proposals || {});
        const offset = wantsMore ? pending.offset || 0 : 0;
        const { choices: nextChoices, offset: nextOffset, total } = buildRecipeChoices(
          driveTitles,
          usedTitles,
          query,
          offset,
          5
        );
        if (!nextChoices.length) {
          return res.json({
            ok: true,
            action: null,
            summary: "Je n'ai pas trouvé d'autres idées. Tu veux quel type de recette ?"
          });
        }
        if (nextChoices.length === 1) {
          const chosenTitle = nextChoices[0];
          delete chatData.pending_recipe_choices;
          if (slot) {
            chatData.updated_at = nowIso();
            await safeWriteChat(chatPathFile, chatData);
            const label = SLOT_LABELS[slot] || slot;
            return res.json({
              ok: true,
              action: {
                action_type: "force_menu_confirm",
                slot,
                title: chosenTitle,
                source: "CHAT_USER"
              },
              summary: `Confirme: tu veux "${chosenTitle}" (${label}) ? (Valider = oui, Refuser = non)`
            });
          }
          chatData.pending_recipe_target = { title: chosenTitle, created_at: nowIso() };
          chatData.updated_at = nowIso();
          await safeWriteChat(chatPathFile, chatData);
          return res.json({
            ok: true,
            action: null,
            summary: `Je n'ai trouvé qu'une option: "${chosenTitle}". Pour quel repas veux-tu l'utiliser ?`
          });
        }
        chatData.pending_recipe_choices = {
          choices: nextChoices,
          slot: slot || null,
          query: query || "",
          offset: nextOffset,
          created_at: nowIso()
        };
        chatData.last_recipe_suggestions = {
          slot: slot || null,
          query: query || "",
          offset: nextOffset,
          total,
          updated_at: nowIso()
        };
        chatData.updated_at = nowIso();
        await safeWriteChat(chatPathFile, chatData);
        const list = nextChoices.map((c, i) => `${i + 1}. ${c}`).join("\n");
        return res.json({
          ok: true,
          action: null,
          summary: `Voici des propositions${query ? ` pour \"${query}\"` : ""}:\n${list}\n\nChoisis 1-${nextChoices.length} ou recopie le titre.`
        });
      }

      let chosen = null;
      const num = Number(msg);
      if (Number.isInteger(num) && num >= 1 && num <= choices.length) {
        chosen = choices[num - 1];
      } else {
        const normMsg = normalizePlain(msg);
        chosen = choices.find((c) => normalizePlain(c) === normMsg) || null;
        if (!chosen) {
          chosen =
            choices.find((c) => normalizePlain(c).includes(normMsg)) ||
            choices.find((c) => normMsg.includes(normalizePlain(c))) ||
            null;
        }
      }

      if (chosen) {
        const slot = pending.slot || detectSlotInMessage(message);
        delete chatData.pending_recipe_choices;
        if (slot) {
          chatData.updated_at = nowIso();
          await safeWriteChat(chatPathFile, chatData);
          const label = SLOT_LABELS[slot] || slot;
          return res.json({
            ok: true,
            action: {
              action_type: "force_menu_confirm",
              slot,
              title: chosen,
              source: "CHAT_USER"
            },
            summary: `Confirme: tu veux "${chosen}" (${label}) ? (Valider = oui, Refuser = non)`
          });
        }
        chatData.pending_recipe_target = { title: chosen, created_at: nowIso() };
        chatData.updated_at = nowIso();
        await safeWriteChat(chatPathFile, chatData);
        return res.json({
          ok: true,
          action: null,
          summary: `Tu choisis "${chosen}". Pour quel repas veux-tu l'utiliser ?`
        });
      }

      const list = choices.map((c, i) => `${i + 1}. ${c}`).join("\n");
      return res.json({
        ok: true,
        action: null,
        summary: `Choisis une option (1-${choices.length}) ou recopie le titre:\n${list}`
      });
    }

    const cancelSlot = detectCancelSlot(message);
    if (cancelSlot) {
      return res.json({
        ok: true,
        action: { action_type: "cancel_slot", slot: cancelSlot },
        summary: `Annuler ${SLOT_LABELS[cancelSlot] || cancelSlot}`
      });
    }

    if (detectListConstraints(message)) {
      const constraints = await readConstraints();
      const summary = formatConstraintsReply(weekId, weekData, constraints);
      return res.json({ ok: true, action: null, summary });
    }

    const replaceAction = detectReplaceProposal(message);
    if (replaceAction) {
      const noLunchSlots = new Set(
        weekData?.rules_readonly?.no_lunch_slots || ["mon_lunch", "tue_lunch", "thu_lunch", "fri_lunch"]
      );
      const isProposalSlot = !noLunchSlots.has(replaceAction.slot);
      if (isProposalSlot) {
        const label = SLOT_LABELS[replaceAction.slot] || replaceAction.slot;
        return res.json({
          ok: true,
          action: {
            action_type: "force_menu_confirm",
            slot: replaceAction.slot,
            title: replaceAction.title,
            source: replaceAction.source || "CHAT_USER"
          },
          summary: `Confirme: tu veux "${replaceAction.title}" (${label}) ? (Valider = oui, Refuser = non)`
        });
      }
      return res.json({
        ok: true,
        action: { action_type: "replace_proposal", ...replaceAction },
        summary: `Remplacer ${SLOT_LABELS[replaceAction.slot]} par "${replaceAction.title}"`
      });
    }

    const moveAction = detectMoveProposal(message);
    if (moveAction) {
      return res.json({
        ok: true,
        action: { action_type: "move_slot", ...moveAction },
        summary: `Déplacer ${SLOT_LABELS[moveAction.from_slot]} vers ${SLOT_LABELS[moveAction.to_slot]}`
      });
    }

    const banAction = detectWeekBanConstraint(message);
    if (banAction) {
      return res.json({
        ok: true,
        action: { action_type: "add_constraint_week", ...banAction },
        summary: `Ajouter contrainte semaine: "${banAction.constraint}"`
      });
    }

      const recipeSuggestion = detectRecipeSuggestionRequest(message);
    if (recipeSuggestion) {
      const slot = recipeSuggestion.slot;
      const query = recipeSuggestion.query;
      const driveTitles = await listDriveIndexTitles();
      const usedTitles = await collectUsedTitlesForWeek(weekData, chatData.menu_proposals || {});
      const prev = chatData.last_recipe_suggestions || null;
      const prevOffset =
        prev && prev.slot === (slot || null) && prev.query === (query || "")
          ? prev.offset || 0
          : 0;
      const { choices, offset, total } = buildRecipeChoices(
        driveTitles,
        usedTitles,
        query,
        prevOffset,
        5
      );
      if (!choices.length) {
        return res.json({
          ok: true,
          action: null,
          summary: "Je n'ai pas trouvé d'idées. Tu veux quel type de recette ?"
        });
      }
      if (choices.length === 1) {
        const chosenTitle = choices[0];
        if (slot) {
          const label = SLOT_LABELS[slot] || slot;
          return res.json({
            ok: true,
            action: {
              action_type: "force_menu_confirm",
              slot,
              title: chosenTitle,
              source: "CHAT_USER"
            },
            summary: `Confirme: tu veux "${chosenTitle}" (${label}) ? (Valider = oui, Refuser = non)`
          });
        }
        chatData.pending_recipe_target = { title: chosenTitle, created_at: nowIso() };
        chatData.updated_at = nowIso();
        await safeWriteChat(chatPathFile, chatData);
        return res.json({
          ok: true,
          action: null,
          summary: `Je n'ai trouvé qu'une option: "${chosenTitle}". Pour quel repas veux-tu l'utiliser ?`
        });
      }
      chatData.pending_recipe_choices = {
        choices,
        slot: slot || null,
        query: query || "",
        offset,
        created_at: nowIso()
      };
      chatData.last_recipe_suggestions = {
        slot: slot || null,
        query: query || "",
        offset,
        total,
        updated_at: nowIso()
      };
      chatData.updated_at = nowIso();
      await safeWriteChat(chatPathFile, chatData);
        const list = choices.map((c, i) => `${i + 1}. ${c}`).join("\n");
      return res.json({
        ok: true,
        action: null,
        summary: `Voici des propositions${query ? ` pour \"${query}\"` : ""}:\n${list}\n\nChoisis 1-${choices.length} ou recopie le titre.`
      });
    }

    const titleForSlot = detectTitleForSlot(message);
    if (titleForSlot) {
      const { slot, title } = titleForSlot;
      if (!title) {
        return res.json({
          ok: true,
          action: null,
          summary: `Quel titre de recette veux-tu pour ${SLOT_LABELS[slot] || slot} ?`
        });
      }
      const label = SLOT_LABELS[slot] || slot;
      return res.json({
        ok: true,
        action: {
          action_type: "force_menu_confirm",
          slot,
          title,
          source: "CHAT_USER"
        },
        summary: `Confirme: tu veux "${title}" (${label}) ? (Valider = oui, Refuser = non)`
      });
    }

    const recipeForSlot = detectRecipeForSlot(message);
    if (recipeForSlot) {
      const { slot, title } = recipeForSlot;
      if (!title) {
        return res.json({
          ok: true,
          action: null,
          summary: `Quel titre de recette veux-tu pour ${SLOT_LABELS[slot] || slot} ?`
        });
      }
      const label = SLOT_LABELS[slot] || slot;
      return res.json({
        ok: true,
        action: {
          action_type: "force_menu_confirm",
          slot,
          title,
          source: "CHAT_USER"
        },
        summary: `Confirme: tu veux "${title}" (${label}) ? (Valider = oui, Refuser = non)`
      });
    }

    const openai = getOpenAIClient();
    if (!openai) return res.status(500).json({ error: "openai_not_configured" });

    const model = getCheapModel();
    const prompt = [
      "Tu reçois une demande utilisateur en langage courant.",
      "Ta tâche: proposer UNE action structurée à valider.",
      "Actions possibles:",
      "- replace_proposal: remplace une proposition pour un slot (sans générer de fiche).",
      "- force_menu_confirm: force un menu sur un slot (demande de confirmation).",
      "- force_menu_recipe: ajoute ou non une recette pour un menu forcé.",
      "- move_slot: déplace le repas d’un slot vers un autre.",
      "- cancel_slot: annule un repas (vide le slot et supprime les propositions).",
      "- add_constraint_week: ajoute une contrainte pour la semaine.",
      "- add_constraint_global: ajoute une contrainte permanente.",
      "- remove_constraint_week: supprime une contrainte semaine.",
      "- remove_constraint_global: supprime une contrainte permanente.",
      "- chat_recipe: fournir une recette en réponse (sans changer la semaine).",
      "- chat_reply: répondre en texte libre (sans action).",
      "Si la demande est ambiguë: utiliser chat_reply et demander précision.",
      "Exemples:",
      'Utilisateur: "annule mercredi dîner" -> {"action_type":"cancel_slot","slot":"wed_dinner"}',
      'Utilisateur: "pas de repas vendredi soir" -> {"action_type":"cancel_slot","slot":"fri_dinner"}',
      'Utilisateur: "mets le repas du samedi déjeuner au jeudi dîner" -> {"action_type":"move_slot","from_slot":"sat_lunch","to_slot":"thu_dinner"}',
      'Utilisateur: "donne moi une recette de soupe pour dimanche soir" -> {"action_type":"force_menu_confirm","slot":"sun_dinner","title":"soupe"}',
      'Utilisateur: "pas d’omelette cette semaine" -> {"action_type":"add_constraint_week","constraint":"Interdit: omelette"}',
      "Slots disponibles:",
      slotLines,
      "Réponds STRICTEMENT en JSON avec ces clés:",
      '{"action_type":"replace_proposal|force_menu_confirm|force_menu_recipe|cancel_slot|move_slot|add_constraint_week|add_constraint_global|remove_constraint_week|remove_constraint_global|chat_recipe|chat_reply","slot":"mon_dinner","title":"...", "from_slot":"mon_dinner", "to_slot":"tue_dinner", "constraint":"...", "message":"...", "recipe_title":"...", "generate_recipe":true}',
      "Règles:",
      "- slot requis seulement pour replace_proposal et cancel_slot.",
      "- from_slot et to_slot requis pour move_slot.",
      "- title requis seulement pour replace_proposal.",
      "- title requis pour force_menu_confirm et force_menu_recipe.",
      "- si un slot/repas est mentionné, ne pas utiliser chat_recipe: utiliser force_menu_confirm.",
      "- generate_recipe requis pour force_menu_recipe.",
      "- constraint requis pour add/remove constraint.",
      "- message requis pour chat_reply.",
      "- recipe_title requis pour chat_recipe.",
      ...buildStaticConstraintsPromptSummaryLines(),
      `Demande utilisateur: "${message}"`
    ].join("\n");

    const resp = await openai.responses.create({
      model,
      input: prompt
    });
    const raw = resp.output_text || "";
    let action = null;
    try {
      action = JSON.parse(raw);
    } catch (_e) {
      console.warn("[commands/parse] invalid json", { raw_text: String(raw).slice(0, 800) });
      return res.json({
        ok: true,
        action: null,
        summary: "Je n'ai pas compris. Peux-tu reformuler plus simplement ?"
      });
    }

    const actionType = String(action?.action_type || "");
    if (!actionType) {
      return res.status(500).json({ error: "command_parse_invalid", raw_text: raw });
    }

    let summary = "";
    if (actionType === "replace_proposal") {
      const slot = action?.slot;
      const rawTitle = String(action?.title || "");
      const sansItem = extractSansItem(rawTitle);
      let title = stripSansClause(rawTitle);
      if (sansItem) {
        title = removeItemFromTitle(title, sansItem);
      }
      if (!action.source) {
        action.source = inferReplaceSourceFromTitle(title);
      }
      summary = `Remplacer ${SLOT_LABELS[slot] || slot} par "${title}"`;
      return res.json({ ok: true, action, summary });
    }
    if (actionType === "force_menu_confirm") {
      const slot = action?.slot;
      const title = String(action?.title || "").trim();
      if (!slot || !title) {
        return res.json({
          ok: true,
          action: null,
          summary: "Quel repas et quel titre veux-tu forcer ?"
        });
      }
      const label = SLOT_LABELS[slot] || slot;
      return res.json({
        ok: true,
        action: {
          action_type: "force_menu_confirm",
          slot,
          title,
          source: action?.source || "CHAT_USER"
        },
        summary: `Confirme: tu veux "${title}" (${label}) ? (Valider = oui, Refuser = non)`
      });
    }
    if (actionType === "force_menu_recipe") {
      const slot = action?.slot;
      const title = String(action?.title || "").trim();
      if (!slot || !title) {
        return res.json({
          ok: true,
          action: null,
          summary: "Quel repas et quel titre veux-tu forcer ?"
        });
      }
      const label = SLOT_LABELS[slot] || slot;
      return res.json({
        ok: true,
        action: {
          action_type: "force_menu_recipe",
          slot,
          title,
          generate_recipe: true,
          source: action?.source || "CHAT_USER"
        },
        reject_action: {
          action_type: "force_menu_recipe",
          slot,
          title,
          generate_recipe: false,
          source: action?.source || "CHAT_USER"
        },
        summary: `Tu veux la recette pour "${title}" (${label}) ? (Valider = oui, Refuser = non)`
      });
    }
    if (actionType === "force_menu") {
      const slot = action?.slot;
      const title = String(action?.title || "").trim();
      if (!slot || !title) {
        return res.json({
          ok: true,
          action: null,
          summary: "Quel repas et quel titre veux-tu forcer ?"
        });
      }
      const label = SLOT_LABELS[slot] || slot;
      return res.json({
        ok: true,
        action: {
          action_type: "force_menu_recipe",
          slot,
          title,
          generate_recipe: true,
          source: action?.source || "CHAT_USER"
        },
        reject_action: {
          action_type: "force_menu_recipe",
          slot,
          title,
          generate_recipe: false,
          source: action?.source || "CHAT_USER"
        },
        summary: `Tu veux la recette pour "${title}" (${label}) ? (Valider = oui, Refuser = non)`
      });
    }
    if (actionType === "cancel_slot") {
      const slot = action?.slot;
      summary = `Annuler ${SLOT_LABELS[slot] || slot}`;
      return res.json({ ok: true, action, summary });
    }
    if (actionType === "move_slot") {
      const fromSlot = action?.from_slot;
      const toSlot = action?.to_slot;
      summary = `Déplacer ${SLOT_LABELS[fromSlot] || fromSlot} vers ${SLOT_LABELS[toSlot] || toSlot}`;
      return res.json({ ok: true, action, summary });
    }
    if (actionType === "add_constraint_week") {
      summary = `Ajouter contrainte semaine: "${action?.constraint}"`;
      return res.json({ ok: true, action, summary });
    }
    if (actionType === "add_constraint_global") {
      summary = `Ajouter contrainte permanente: "${action?.constraint}"`;
      return res.json({ ok: true, action, summary });
    }
    if (actionType === "remove_constraint_week") {
      summary = `Supprimer contrainte semaine: "${action?.constraint}"`;
      return res.json({ ok: true, action, summary });
    }
    if (actionType === "remove_constraint_global") {
      summary = `Supprimer contrainte permanente: "${action?.constraint}"`;
      return res.json({ ok: true, action, summary });
    }
    if (actionType === "chat_recipe") {
      const recipeTitle = String(action?.recipe_title || "").trim();
      if (!recipeTitle) {
        return res.json({
          ok: true,
          action: null,
          summary: action?.message || "Quelle recette souhaites-tu ?"
        });
      }
      const preview = await buildPreviewFromTitle(recipeTitle, null);
      summary = formatRecipePreview(recipeTitle, preview);
      return res.json({ ok: true, action: null, summary });
    }
    if (actionType === "chat_reply") {
      summary = action?.message || "OK.";
      return res.json({ ok: true, action: null, summary });
    }

    return res.status(500).json({ error: "command_parse_invalid", raw_text: raw });
  } catch (e) {
    return res.status(500).json({ error: "command_parse_failed", details: e.message });
  }
});

/**
 * POST /api/chat/commands/apply
 * body: { week_id, action }
 */
router.post("/commands/apply", async (req, res) => {
  const weekId = String(req.body?.week_id || "");
  const action = req.body?.action || null;
  if (!weekId) return res.status(400).json({ error: "missing_week_id" });
  if (!action || typeof action !== "object") {
    return res.status(400).json({ error: "missing_action" });
  }

  const type = String(action.action_type || "");
  try {
    if (type === "replace_proposal") {
      const slot = String(action.slot || "");
      const title = String(action.title || "").trim();
      if (!slot || !title) {
        return res.status(400).json({ error: "missing_slot_or_title" });
      }

      const weekData = await readJson(path.join(DATA_DIR, "weeks", `${weekId}.json`)).catch(
        () => null
      );
      const noLunchSlots = new Set(
        weekData?.rules_readonly?.no_lunch_slots || ["mon_lunch", "tue_lunch", "thu_lunch", "fri_lunch"]
      );
      if (noLunchSlots.has(slot)) {
        return res.status(400).json({ error: "slot_not_allowed" });
      }
      if (weekData?.slots?.[slot]?.validated === true) {
        weekData.slots[slot] = {
          ...weekData.slots[slot],
          recipe_id: null,
          free_text: "",
          validated: false,
          source_type: null
        };
        weekData.updated_at = nowIso();
        const weekPath = path.join(DATA_DIR, "weeks", `${weekId}.json`);
        await writeJson(weekPath, weekData);
      }

      const { path: p, data } = await ensureChatFile(weekId);
      if (!data.menu_proposals || typeof data.menu_proposals !== "object") {
        data.menu_proposals = {};
      }
      data.menu_proposals[slot] = [
        {
          proposal_id: newProposalId(),
          title,
          recipe_id: null,
          source: action?.source ? String(action.source) : "CHAT_USER",
          status: "PROPOSED",
          to_save: false,
          created_at: nowIso()
        }
      ];
      data.updated_at = nowIso();
      await safeWriteChat(p, data);

      return res.json({
        ok: true,
        action_applied: type,
        slot,
        menu_proposals: { [slot]: data.menu_proposals[slot] }
      });
    }

    if (type === "force_menu_confirm") {
      const slot = String(action.slot || "");
      const title = String(action.title || "").trim();
      if (!slot || !title) {
        return res.status(400).json({ error: "missing_slot_or_title" });
      }

      const weekPath = path.join(DATA_DIR, "weeks", `${weekId}.json`);
      const weekData = await readJson(weekPath).catch(() => null);
      if (!weekData) return res.status(404).json({ error: "week_not_found" });

      const noLunchSlots = new Set(
        weekData?.rules_readonly?.no_lunch_slots || ["mon_lunch", "tue_lunch", "thu_lunch", "fri_lunch"]
      );
      if (noLunchSlots.has(slot)) {
        return res.status(400).json({ error: "slot_not_allowed" });
      }

      weekData.slots = weekData.slots || {};
      const slotData = weekData.slots[slot] || {};
      weekData.slots[slot] = {
        ...slotData,
        recipe_id: null,
        free_text: title,
        validated: true,
        source_type: action?.source ? String(action.source) : "CHAT_USER"
      };
      delete weekData.slots[slot].generated_recipe;
      delete weekData.slots[slot].generated_recipe_people_signature;

      weekData.updated_at = nowIso();
      await writeJson(weekPath, weekData);

      const { path: p, data } = await ensureChatFile(weekId);
      if (!data.menu_proposals || typeof data.menu_proposals !== "object") {
        data.menu_proposals = {};
      }
      data.menu_proposals[slot] = [];
      data.updated_at = nowIso();
      await safeWriteChat(p, data);

      const label = SLOT_LABELS[slot] || slot;
      return res.json({
        ok: true,
        action_applied: type,
        slot,
        week: weekData,
        menu_proposals: { [slot]: [] },
        followup_action: {
          action_type: "force_menu_recipe",
          slot,
          title,
          generate_recipe: true,
          source: action?.source ? String(action.source) : "CHAT_USER"
        },
        followup_reject_action: {
          action_type: "force_menu_recipe",
          slot,
          title,
          generate_recipe: false,
          source: action?.source ? String(action.source) : "CHAT_USER"
        },
        followup_summary: `Tu veux la recette pour "${title}" (${label}) ? (Valider = oui, Refuser = non)`
      });
    }

    if (type === "force_menu_recipe" || type === "force_menu") {
      const slot = String(action.slot || "");
      const title = String(action.title || "").trim();
      const wantsRecipe = action?.generate_recipe === true;
      if (!slot || !title) {
        return res.status(400).json({ error: "missing_slot_or_title" });
      }

      const weekPath = path.join(DATA_DIR, "weeks", `${weekId}.json`);
      const weekData = await readJson(weekPath).catch(() => null);
      if (!weekData) return res.status(404).json({ error: "week_not_found" });

      const noLunchSlots = new Set(
        weekData?.rules_readonly?.no_lunch_slots || ["mon_lunch", "tue_lunch", "thu_lunch", "fri_lunch"]
      );
      if (noLunchSlots.has(slot)) {
        return res.status(400).json({ error: "slot_not_allowed" });
      }

      weekData.slots = weekData.slots || {};
      const slotData = weekData.slots[slot] || {};
      weekData.slots[slot] = {
        ...slotData,
        recipe_id: null,
        free_text: title,
        validated: true,
        source_type: action?.source ? String(action.source) : "CHAT_USER"
      };

      if (wantsRecipe) {
        const people = weekData.slots[slot]?.people || null;
        const preview = await buildPreviewFromTitle(title, people);
        weekData.slots[slot].generated_recipe = preview;
        weekData.slots[slot].generated_recipe_people_signature = peopleSignature(people);
      } else {
        delete weekData.slots[slot].generated_recipe;
        delete weekData.slots[slot].generated_recipe_people_signature;
      }

      weekData.updated_at = nowIso();
      await writeJson(weekPath, weekData);

      const { path: p, data } = await ensureChatFile(weekId);
      if (!data.menu_proposals || typeof data.menu_proposals !== "object") {
        data.menu_proposals = {};
      }
      data.menu_proposals[slot] = [];
      data.updated_at = nowIso();
      await safeWriteChat(p, data);

      return res.json({
        ok: true,
        action_applied: type,
        slot,
        week: weekData,
        menu_proposals: { [slot]: [] }
      });
    }

    if (type === "cancel_slot") {
      const slot = String(action.slot || "");
      if (!slot) {
        return res.status(400).json({ error: "missing_slot" });
      }

      const weekPath = path.join(DATA_DIR, "weeks", `${weekId}.json`);
      const weekData = await readJson(weekPath).catch(() => null);
      if (!weekData) return res.status(404).json({ error: "week_not_found" });
      if (!weekData?.slots?.[slot]) {
        return res.status(400).json({ error: "unknown_slot" });
      }

      weekData.slots[slot] = {
        ...weekData.slots[slot],
        recipe_id: null,
        free_text: "",
        validated: false,
        source_type: null
      };
      weekData.updated_at = nowIso();
      await writeJson(weekPath, weekData);

      const { path: p, data } = await ensureChatFile(weekId);
      if (!data.menu_proposals || typeof data.menu_proposals !== "object") {
        data.menu_proposals = {};
      }
      data.menu_proposals[slot] = [];
      data.updated_at = nowIso();
      await safeWriteChat(p, data);

      return res.json({
        ok: true,
        action_applied: type,
        slot,
        week: weekData,
        menu_proposals: { [slot]: [] }
      });
    }

    if (type === "move_slot") {
      const fromSlot = String(action.from_slot || "");
      const toSlot = String(action.to_slot || "");
      if (!fromSlot || !toSlot) {
        return res.status(400).json({ error: "missing_from_or_to_slot" });
      }

      const weekPath = path.join(DATA_DIR, "weeks", `${weekId}.json`);
      const weekData = await readJson(weekPath).catch(() => null);
      if (!weekData) return res.status(404).json({ error: "week_not_found" });
      if (!weekData?.slots?.[fromSlot] || !weekData?.slots?.[toSlot]) {
        return res.status(400).json({ error: "unknown_slot" });
      }

      const noLunchSlots = new Set(
        weekData?.rules_readonly?.no_lunch_slots || ["mon_lunch", "tue_lunch", "thu_lunch", "fri_lunch"]
      );
      if (noLunchSlots.has(toSlot)) {
        return res.status(400).json({ error: "slot_not_allowed" });
      }

      const source = weekData.slots[fromSlot] || {};
      const hasSlotData =
        source?.validated === true || source?.recipe_id || (source?.free_text || "").trim();

      if (hasSlotData) {
        const target = weekData.slots[toSlot] || {};
        weekData.slots[toSlot] = {
          ...target,
          recipe_id: source.recipe_id || null,
          free_text: source.free_text || "",
          validated: source.validated === true,
          source_type: source.source_type || null
        };
        weekData.slots[fromSlot] = {
          ...source,
          recipe_id: null,
          free_text: "",
          validated: false,
          source_type: null
        };
        weekData.updated_at = nowIso();
        await writeJson(weekPath, weekData);
        return res.json({
          ok: true,
          action_applied: type,
          from_slot: fromSlot,
          to_slot: toSlot,
          week: weekData
        });
      }

      const { path: p, data } = await ensureChatFile(weekId);
      if (!data.menu_proposals || typeof data.menu_proposals !== "object") {
        data.menu_proposals = {};
      }
      const sourceProposals = data.menu_proposals[fromSlot] || [];
      if (!sourceProposals.length) {
        return res.status(404).json({ error: "nothing_to_move" });
      }
      data.menu_proposals[toSlot] = sourceProposals;
      data.menu_proposals[fromSlot] = [];
      data.updated_at = nowIso();
      await safeWriteChat(p, data);
      return res.json({
        ok: true,
        action_applied: type,
        from_slot: fromSlot,
        to_slot: toSlot,
        menu_proposals: {
          [fromSlot]: [],
          [toSlot]: sourceProposals
        }
      });
    }

    const constraints = await readConstraints();
    if (type === "add_constraint_week") {
      const text = normalizeConstraint(action.constraint);
      if (!text) return res.status(400).json({ error: "missing_constraint" });
      const list = Array.isArray(constraints.weeks?.[weekId])
        ? constraints.weeks[weekId]
        : [];
      if (!list.includes(text)) list.push(text);
      constraints.weeks[weekId] = list;
      await writeConstraints(constraints);
      return res.json({ ok: true, action_applied: type, constraint: text });
    }

    if (type === "add_constraint_global") {
      const text = normalizeConstraint(action.constraint);
      if (!text) return res.status(400).json({ error: "missing_constraint" });
      const list = Array.isArray(constraints.global) ? constraints.global : [];
      if (!list.includes(text)) list.push(text);
      constraints.global = list;
      await writeConstraints(constraints);
      return res.json({ ok: true, action_applied: type, constraint: text });
    }

    if (type === "remove_constraint_week") {
      const text = normalizeConstraint(action.constraint);
      if (!text) return res.status(400).json({ error: "missing_constraint" });
      const list = Array.isArray(constraints.weeks?.[weekId])
        ? constraints.weeks[weekId]
        : [];
      constraints.weeks[weekId] = list.filter((x) => x !== text);
      await writeConstraints(constraints);
      return res.json({ ok: true, action_applied: type, constraint: text });
    }

    if (type === "remove_constraint_global") {
      const text = normalizeConstraint(action.constraint);
      if (!text) return res.status(400).json({ error: "missing_constraint" });
      const list = Array.isArray(constraints.global) ? constraints.global : [];
      constraints.global = list.filter((x) => x !== text);
      await writeConstraints(constraints);
      return res.json({ ok: true, action_applied: type, constraint: text });
    }

    return res.status(400).json({ error: "unknown_action_type" });
  } catch (e) {
    return res.status(500).json({ error: "command_apply_failed", details: e.message });
  }
});

export default router;
