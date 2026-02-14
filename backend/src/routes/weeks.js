import express from "express";
import path from "path";
import fs from "fs/promises";
import fsSync from "fs";
import OpenAI from "openai";
import { readJson, writeJson } from "../lib/jsonStore.js";
import { DATA_DIR, PROJECT_ROOT } from "../lib/dataPaths.js";

const router = express.Router();

const WEEKS_DIR = path.join(DATA_DIR, "weeks");
const RECIPES_DIR = path.join(DATA_DIR, "recipes");
const CHAT_DIR = path.join(DATA_DIR, "chat_sessions");

function nowIso() {
  return new Date().toISOString();
}

function readOpenAIKeyFromSecretsDir() {
  const secretsDir = (process.env.MEAL_PLANNER_SECRETS_DIR || "").trim();
  if (!secretsDir) {
    const fallback = path.join(PROJECT_ROOT, "credentials");
    if (fsSync.existsSync(fallback)) {
      const keyPath = path.join(fallback, "openai_api_key.txt");
      if (!fsSync.existsSync(keyPath)) return "";
      try {
        const raw = fsSync.readFileSync(keyPath, "utf8");
        return String(raw || "").trim();
      } catch {
        return "";
      }
    }
  }
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
  return new OpenAI({ apiKey: key });
}

function getModel() {
  return process.env.OPENAI_MODEL || "gpt-5.2";
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * readJson peut throw:
 * - ENOENT (fichier absent)
 * - SyntaxError / "Unexpected end of JSON input" (fichier vide/partiel/corrompu)
 * Ici on traite "vide/partiel/corrompu JSON" comme "absent" pour pouvoir recréer proprement.
 */
async function safeReadJson(filePath) {
  try {
    return await readJson(filePath);
  } catch (e) {
    const msg = String(e?.message || "");
    const isUnexpectedEnd = msg.includes("Unexpected end of JSON input");
    const isEmptyJson =
      e?.code === "EMPTY_JSON" || msg.includes("Empty JSON file:");
    const isSyntaxError =
      e?.name === "SyntaxError" || msg.toLowerCase().includes("syntaxerror");

    if (e?.code === "ENOENT") return null;
    if (isUnexpectedEnd || isSyntaxError || isEmptyJson) return null;

    throw e;
  }
}

function isValidWeekId(weekId) {
  // Format: YYYY-WNN (ex: 2026-W01)
  if (typeof weekId !== "string") return false;
  const m = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return false;
  const weekNum = Number(m[2]);
  return Number.isInteger(weekNum) && weekNum >= 1 && weekNum <= 99;
}

function isISODate(d) {
  // basic format check
  if (typeof d !== "string") return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return false;

  // validate actual date exists (e.g., reject 2026-02-31)
  const t = Date.parse(d + "T00:00:00Z");
  if (Number.isNaN(t)) return false;

  // ensure parsing preserves the same Y-M-D (avoid weird parsing edge cases)
  const iso = new Date(t).toISOString().slice(0, 10);
  return iso === d;
}

function compareISODate(a, b) {
  // a,b are YYYY-MM-DD
  const ta = Date.parse(a + "T00:00:00Z");
  const tb = Date.parse(b + "T00:00:00Z");
  return ta - tb;
}

function rangesOverlap(aStart, aEnd, bStart, bEnd) {
  return compareISODate(aStart, bEnd) <= 0 && compareISODate(bStart, aEnd) <= 0;
}

function normalizeIngredientKey(text) {
  return String(text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function parseQty(raw) {
  const s = String(raw || "").trim().replace(",", ".");
  if (!s) return null;
  if (!/^\d+(\.\d+)?$/.test(s)) return null;
  const v = Number(s);
  return Number.isFinite(v) ? v : null;
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

  const model = getModel();
  const peopleLine = people
    ? `Personnes: ${people.adults || 0} adulte(s), ${people.children || 0} enfant(s) (${(people.child_birth_months || []).join(", ") || "n/a"}).`
    : "";

  const prompt = [
    `Génère une fiche courte de recette pour : "${title}".`,
    peopleLine,
    "Réponds STRICTEMENT en JSON avec ces clés:",
    '{"description_courte":"...", "ingredients":[{"item":"...","qty":"...","unit":"..."}], "preparation_steps":["...","..."]}',
    "IMPORTANT: preparation_steps doit contenir au moins 3 étapes."
  ].join("\n");

  const resp = await openai.responses.create({
    model,
    input: prompt
  });

  const raw = resp.output_text || "";
  try {
    return JSON.parse(raw);
  } catch (_e) {
    const err = new Error("preview_parse_failed");
    err.code = "preview_parse_failed";
    err.raw_text = raw;
    throw err;
  }
}

function slotPrefixFromDate(dateObj) {
  const day = dateObj.getUTCDay(); // 0=Sun
  const map = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
  return map[day];
}

function activeSlotsFromRange(dateStart, dateEnd) {
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
  return out.filter((s) => ALLOWED_SLOTS.has(s));
}

async function listWeekFiles() {
  await ensureDir(WEEKS_DIR);
  const files = await fs.readdir(WEEKS_DIR);
  return files.filter((f) => f.endsWith(".json"));
}

async function loadWeek(weekId) {
  const p = path.join(WEEKS_DIR, `${weekId}.json`);
  const week = await safeReadJson(p);
  if (!week) {
    const err = new Error(`Week not found: ${weekId}`);
    err.code = "ENOENT";
    throw err;
  }
  return week;
}

async function ensureRecipeExists(recipeId) {
  await ensureDir(RECIPES_DIR);

  const p = path.join(RECIPES_DIR, `${recipeId}.json`);
  const existing = await safeReadJson(p);
  if (existing) return;

  const stub = {
    recipe_id: recipeId,
    title: `${recipeId} (placeholder)`,
    source: { type: "LOCAL", drive_path: "" },
    status: "A_MODIFIER",
    servings: 3,
    season: ["hiver"],
    main_ingredient: "",
    notes: "placeholder_auto_generated",
    content: {
      description_courte: "Recette placeholder pour tests cockpit.",
      ingredients: [],
      preparation_steps: ["1. TODO"],
      cuisson: "",
      finition_service: "",
      conseils_variantes: ""
    },
    updated_at: nowIso()
  };

  await writeJson(p, stub);
}

const DEFAULT_CHILD_BIRTH_MONTHS = ["2016-08"];

function defaultPeople() {
  return {
    adults: 2,
    children: 1,
    child_birth_months: [...DEFAULT_CHILD_BIRTH_MONTHS]
  };
}

function normalizePeople(raw) {
  if (!raw || typeof raw !== "object") return null;

  const adults = Number.isFinite(raw.adults) ? Math.max(0, Math.floor(raw.adults)) : null;
  const children = Number.isFinite(raw.children)
    ? Math.max(0, Math.floor(raw.children))
    : null;

  if (adults === null || children === null) return null;

  let child_birth_months = Array.isArray(raw.child_birth_months)
    ? raw.child_birth_months
        .map((s) => String(s))
        .filter((s) => /^\d{4}-\d{2}$/.test(s))
    : [];

  if (child_birth_months.length === 0 && Array.isArray(raw.child_birth_years)) {
    child_birth_months = raw.child_birth_years
      .map((y) => Number(y))
      .filter((y) => Number.isFinite(y))
      .map((y) => `${y}-01`);
  }

  if (children > 0 && child_birth_months.length === 0) {
    child_birth_months = Array(children).fill(DEFAULT_CHILD_BIRTH_MONTHS[0]);
  }

  if (children === 0) {
    child_birth_months = [];
  }

  if (child_birth_months.length !== children && children > 0) {
    child_birth_months = Array(children).fill(
      child_birth_months[0] || DEFAULT_CHILD_BIRTH_MONTHS[0]
    );
  }

  return { adults, children, child_birth_months };
}

// Slots autorisés (pour éviter les typos)
const ALLOWED_SLOTS = new Set([
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
]);

function computeValidated(slotObj) {
  const rid = typeof slotObj?.recipe_id === "string" ? slotObj.recipe_id.trim() : "";
  const ft = typeof slotObj?.free_text === "string" ? slotObj.free_text.trim() : "";
  return Boolean(rid) || Boolean(ft);
}

/**
 * GET /api/weeks/list
 */
router.get("/list", async (_req, res) => {
  try {
    const files = await listWeekFiles();
    const ids = files.map((f) => f.replace(".json", "")).sort();
    res.json({ week_ids: ids });
  } catch (e) {
    res.status(500).json({ error: "weeks_list_failed", details: e.message });
  }
});

/**
 * GET /api/weeks/by-dates?date_start=YYYY-MM-DD&date_end=YYYY-MM-DD
 * Returns the week matching the exact date range if it exists.
 */
router.get("/by-dates", async (req, res) => {
  try {
    const dateStart = String(req.query?.date_start || "").trim();
    const dateEnd = String(req.query?.date_end || "").trim();

    if (!dateStart || !dateEnd) {
      return res.status(400).json({
        error: "missing_dates",
        details: "date_start and date_end are required (YYYY-MM-DD)"
      });
    }
    if (!isISODate(dateStart) || !isISODate(dateEnd)) {
      return res.status(400).json({
        error: "invalid_dates",
        details: "Expected ISO dates YYYY-MM-DD (valid calendar dates)"
      });
    }

    const files = await listWeekFiles();
    for (const f of files) {
      const id = f.replace(".json", "");
      const w = await loadWeek(id);
      if (w?.date_start === dateStart && w?.date_end === dateEnd) {
        return res.json(w);
      }
    }

    return res.status(404).json({ error: "week_not_found" });
  } catch (e) {
    return res.status(500).json({ error: "week_by_dates_failed", details: e.message });
  }
});

/**
 * GET /api/weeks/current
 * Choix simple: la semaine "la plus recente" par tri des noms de fichiers.
 */
router.get("/current", async (_req, res) => {
  try {
    const files = await listWeekFiles();
    if (files.length === 0) {
      return res.status(404).json({ error: "no_weeks_found" });
    }

    const ids = files.map((f) => f.replace(".json", "")).sort();
    const currentId = ids[ids.length - 1];
    const week = await loadWeek(currentId);
    res.json(week);
  } catch (e) {
    res.status(500).json({ error: "week_current_failed", details: e.message });
  }
});

/**
 * POST /api/weeks/prepare
 * body: { week_id, date_start, date_end }
 * Cree la semaine si absente, avec slots vides.
 */
router.post("/prepare", async (req, res) => {
  try {
    const weekId = String(req.body?.week_id || "").trim();
    const dateStart = String(req.body?.date_start || "").trim();
    const dateEnd = String(req.body?.date_end || "").trim();

    if (!weekId) return res.status(400).json({ error: "missing_week_id" });
    if (!isValidWeekId(weekId)) {
      return res.status(400).json({
        error: "invalid_week_id",
        details: "Expected format YYYY-WNN (e.g., 2026-W01)"
      });
    }

    if (!dateStart || !dateEnd) {
      return res.status(400).json({
        error: "missing_dates",
        details: "date_start and date_end are required (YYYY-MM-DD)"
      });
    }
    if (!isISODate(dateStart) || !isISODate(dateEnd)) {
      return res.status(400).json({
        error: "invalid_dates",
        details: "Expected ISO dates YYYY-MM-DD (valid calendar dates)"
      });
    }
    if (compareISODate(dateEnd, dateStart) < 0) {
      return res.status(400).json({
        error: "invalid_date_range",
        details: "date_end must be >= date_start"
      });
    }

    await ensureDir(WEEKS_DIR);

    const p = path.join(WEEKS_DIR, `${weekId}.json`);

    // Garde-fou: refuser toute creation si week_id existe deja.
    if (fsSync.existsSync(p)) {
      const existing = await safeReadJson(p);
      return res.status(409).json({ error: "week_exists", week: existing || null });
    }

    // Alerte si recouvrement de dates avec une autre semaine.
    const files = await listWeekFiles();
    for (const f of files) {
      const existingPath = path.join(WEEKS_DIR, f);
      const existingWeek = await safeReadJson(existingPath);
      if (!existingWeek?.date_start || !existingWeek?.date_end) continue;
      if (
        rangesOverlap(
          dateStart,
          dateEnd,
          existingWeek.date_start,
          existingWeek.date_end
        )
      ) {
        return res.status(409).json({
          error: "week_overlap",
          details: `Overlap with ${existingWeek.week_id} (${existingWeek.date_start} to ${existingWeek.date_end})`,
          overlap: {
            week_id: existingWeek.week_id,
            date_start: existingWeek.date_start,
            date_end: existingWeek.date_end
          }
        });
      }
    }

    const activeSlots = activeSlotsFromRange(dateStart, dateEnd);

    // IMPORTANT: slots vides, validated=false partout.
    const week = {
      week_id: weekId,
      date_start: dateStart,
      date_end: dateEnd,
      timezone: "Europe/Paris",
      rules_readonly: {
        no_lunch_slots: ["mon_lunch", "tue_lunch", "thu_lunch", "fri_lunch"],
        active_slots: activeSlots,
        main_ingredient_max_per_week: 2,
        main_ingredient_min_day_gap_if_used_twice: 2,
        seasonality_required: true
      },
      slots: Object.fromEntries(
        activeSlots.map((slot) => [
          slot,
          { recipe_id: null, free_text: "", validated: false, people: defaultPeople() }
        ])
      ),
      updated_at: nowIso()
    };

    await writeJson(p, week);
    res.status(201).json({ created: true, week });
  } catch (e) {
    res.status(500).json({ error: "week_prepare_failed", details: e.message });
  }
});

/**
 * PATCH /api/weeks/:week_id/slots/init-validation
 * Initialise week.slots[slot].validated:
 * - true si recipe_id existe
 * - false sinon
 * Ne touche pas recipe_id / free_text.
 */
router.patch("/:week_id/slots/init-validation", async (req, res) => {
  try {
    const weekId = String(req.params.week_id || "").trim();

    if (!weekId) return res.status(400).json({ error: "missing_week_id" });
    if (!isValidWeekId(weekId)) {
      return res.status(400).json({ error: "invalid_week_id" });
    }

    const p = path.join(WEEKS_DIR, `${weekId}.json`);
    const week = await safeReadJson(p);
    if (!week) return res.status(404).json({ error: "week_not_found" });

    week.slots = week.slots || {};

    for (const slot of ALLOWED_SLOTS) {
      const cur = week.slots[slot] || {};
      const hasRecipe = !!cur.recipe_id;

      // On garde les autres champs, on impose validated selon presence recipe_id
      week.slots[slot] = {
        ...cur,
        validated: hasRecipe,
        people: cur.people || defaultPeople()
      };
    }

    week.updated_at = nowIso();
    await writeJson(p, week);

    return res.json({ ok: true, week });
  } catch (e) {
    return res
      .status(500)
      .json({ error: "week_init_validation_failed", details: e.message });
  }
});


/**
 * PATCH /api/weeks/:week_id/slots/:slot
 * body: { recipe_id?: string|null, free_text?: string|null, source_type?: string|null }
 * - Permet "Valider" une proposition (recipe_id et/ou free_text)
 * - Stocke free_text dans week.slots[slot].free_text
 * - Met week.slots[slot].validated = true si (recipe_id ou free_text non vide), sinon false
 */
router.patch("/:week_id/slots/:slot", async (req, res) => {
  try {
    const weekId = String(req.params.week_id || "").trim();
    const slot = String(req.params.slot || "").trim();

    if (!weekId) return res.status(400).json({ error: "missing_week_id" });
    if (!isValidWeekId(weekId)) {
      return res.status(400).json({ error: "invalid_week_id" });
    }

    if (!slot) return res.status(400).json({ error: "missing_slot" });
    if (!ALLOWED_SLOTS.has(slot)) {
      return res.status(400).json({
        error: "invalid_slot",
        allowed: Array.from(ALLOWED_SLOTS)
      });
    }

    const recipeIdRaw = req.body?.recipe_id;
    const freeTextRaw = req.body?.free_text;
    const peopleRaw = req.body?.people;
    const validatedRaw = req.body?.validated;
    const previewRaw = req.body?.preview;
    const previewSigRaw = req.body?.preview_people_signature;
    const generatedRecipeRaw = req.body?.generated_recipe;
    const generatedRecipeSigRaw = req.body?.generated_recipe_people_signature;
    const sourceTypeRaw = req.body?.source_type;

    // recipe_id: string | null | undefined
    let recipe_id = undefined;
    if (recipeIdRaw === null) recipe_id = null;
    else if (recipeIdRaw !== undefined) {
      const s = String(recipeIdRaw).trim();
      if (!s) recipe_id = null;
      else recipe_id = s;
    }

    // free_text: string | null | undefined
    let free_text = undefined;
    if (freeTextRaw === null) free_text = null;
    else if (freeTextRaw !== undefined) {
      const s = String(freeTextRaw);
      free_text = s; // peut être "" si tu veux explicitement vider
    }

    const people = normalizePeople(peopleRaw);

    // Charger semaine
    const p = path.join(WEEKS_DIR, `${weekId}.json`);
    const week = await safeReadJson(p);
    if (!week) return res.status(404).json({ error: "week_not_found" });

    week.slots = week.slots || {};
    week.slots[slot] = week.slots[slot] || {};

    if (recipe_id !== undefined) {
      if (recipe_id) {
        await ensureRecipeExists(recipe_id);
        week.slots[slot].recipe_id = recipe_id;
      } else {
        // null/empty => on retire recipe_id
        delete week.slots[slot].recipe_id;
      }
    }

    if (free_text !== undefined) {
      if (free_text === null) {
        delete week.slots[slot].free_text;
      } else {
        week.slots[slot].free_text = free_text;
      }
    }

    if (people) {
      week.slots[slot].people = people;
    } else if (!week.slots[slot].people) {
      week.slots[slot].people = defaultPeople();
    }

    if (previewRaw !== undefined) {
      if (previewRaw === null) {
        delete week.slots[slot].preview;
      } else {
        week.slots[slot].preview = previewRaw;
      }
    }

    if (previewSigRaw !== undefined) {
      if (previewSigRaw === null) {
        delete week.slots[slot].preview_people_signature;
      } else {
        week.slots[slot].preview_people_signature = String(previewSigRaw);
      }
    }

    if (generatedRecipeRaw !== undefined) {
      if (generatedRecipeRaw === null) {
        delete week.slots[slot].generated_recipe;
      } else {
        week.slots[slot].generated_recipe = generatedRecipeRaw;
      }
    }

    if (generatedRecipeSigRaw !== undefined) {
      if (generatedRecipeSigRaw === null) {
        delete week.slots[slot].generated_recipe_people_signature;
      } else {
        week.slots[slot].generated_recipe_people_signature = String(generatedRecipeSigRaw);
      }
    }

    if (sourceTypeRaw !== undefined) {
      if (sourceTypeRaw === null) {
        delete week.slots[slot].source_type;
      } else {
        week.slots[slot].source_type = String(sourceTypeRaw).trim();
      }
    }

    // Recalcul validated only when validation-related fields change.
    const shouldRecomputeValidated =
      validatedRaw === true ||
      validatedRaw === false ||
      recipeIdRaw !== undefined ||
      freeTextRaw !== undefined;

    if (validatedRaw === true || validatedRaw === false) {
      week.slots[slot].validated = validatedRaw;
    } else if (shouldRecomputeValidated) {
      week.slots[slot].validated = computeValidated(week.slots[slot]);
    }

    if (validatedRaw === false) {
      delete week.slots[slot].preview;
      delete week.slots[slot].preview_people_signature;
      delete week.slots[slot].generated_recipe;
      delete week.slots[slot].generated_recipe_people_signature;
    }
    if (!week.slots[slot].free_text && !week.slots[slot].recipe_id) {
      delete week.slots[slot].generated_recipe;
      delete week.slots[slot].generated_recipe_people_signature;
    }

    // Free-text slots are user-forced menus; do not auto-generate recipes.

    week.updated_at = nowIso();
    await writeJson(p, week);

    res.json({ ok: true, week });
  } catch (e) {
    res
      .status(500)
      .json({ error: "week_slot_patch_failed", details: e.message });
  }
});

/**
 * GET /api/weeks/:week_id/constraints
 */
router.get("/:week_id/constraints", async (req, res) => {
  try {
    const week = await loadWeek(req.params.week_id);
    res.json({
      week_id: week.week_id,
      rules_readonly: week.rules_readonly || {},
      global_constraints: {
        servings: 3,
        seasonal_veg_required: true,
        no_lunch_days: ["mon", "tue", "thu", "fri"],
        status_flow: ["DRAFT", "VALIDEE", "A_MODIFIER", "REJETEE", "EXTERNE"]
      }
    });
  } catch (e) {
    const status = e?.code === "ENOENT" ? 404 : 500;
    res.status(status).json({ error: "constraints_failed", details: e.message });
  }
});

/**
 * GET /api/weeks/:week_id/audit
 * Basic structural audit against week rules (no lunch slots, filled dinners, people count).
 * Note: seasonality/ingredient repetition require recipe content and are returned as unknown.
 */
router.get("/:week_id/audit", async (req, res) => {
  try {
    const week = await loadWeek(req.params.week_id);
    const slots = week.slots || {};
    const noLunchSlots =
      week.rules_readonly?.no_lunch_slots || ["mon_lunch", "tue_lunch", "thu_lunch", "fri_lunch"];
    let proposalsBySlot = {};
    try {
      const chat = await readJson(path.join(CHAT_DIR, `${week.week_id}.json`));
      if (chat?.menu_proposals && typeof chat.menu_proposals === "object") {
        proposalsBySlot = chat.menu_proposals;
      }
    } catch {
      proposalsBySlot = {};
    }

    const checks = [];
    const slotIssues = [];

    for (const slot of Object.keys(slots)) {
      const inNoLunch = noLunchSlots.includes(slot);
      const proposals = Array.isArray(proposalsBySlot?.[slot]) ? proposalsBySlot[slot] : [];

      if (inNoLunch) {
        if (proposals.length > 0) {
          slotIssues.push({
            slot,
            issue: "no_lunch_slot_should_have_no_proposals",
            status: "fail"
          });
        }
        continue;
      }

      if (proposals.length === 0) {
        slotIssues.push({
          slot,
          issue: "slot_has_no_proposals",
          status: "fail"
        });
      }
    }

    const peopleIssues = [];
    for (const [slot, s] of Object.entries(slots)) {
      const adults = s?.people?.adults;
      const children = s?.people?.children;
      if (adults !== 2 || children !== 1) {
        peopleIssues.push({ slot, adults, children });
      }
    }

    checks.push({
      id: "no_lunch_slots_empty",
      status: slotIssues.some((i) => i.issue === "no_lunch_slot_should_have_no_proposals")
        ? "fail"
        : "pass",
      details: noLunchSlots
    });
    checks.push({
      id: "proposals_present",
      status: slotIssues.some((i) => i.issue === "slot_has_no_proposals") ? "fail" : "pass",
      details: "All non-no-lunch slots should have at least one proposal."
    });
    checks.push({
      id: "people_2A_1E",
      status: peopleIssues.length ? "fail" : "pass",
      details: peopleIssues
    });
    checks.push({
      id: "seasonality_required",
      status: "unknown",
      details: "Requires ingredient analysis."
    });
    checks.push({
      id: "main_ingredient_repetition",
      status: "unknown",
      details: "Requires ingredient analysis."
    });

    const ok = checks.every((c) => c.status === "pass");
    res.json({
      ok,
      week_id: week.week_id,
      checks,
      slot_issues: slotIssues
    });
  } catch (e) {
    const status = e?.code === "ENOENT" ? 404 : 500;
    res.status(status).json({ error: "week_audit_failed", details: e.message });
  }
});

/**
 * GET /api/weeks/:week_id/shopping-list
 * Returns aggregated ingredients for validated recipes.
 */
router.get("/:week_id/shopping-list", async (req, res) => {
  try {
    const week = await loadWeek(req.params.week_id);
    const slots = week.slots || {};
    const itemsMap = new Map();
    const missingRecipes = [];
    const usedRecipes = new Set();
    let weekChanged = false;

    for (const [slot, s] of Object.entries(slots)) {
      if (s?.validated !== true) continue;
      const recipeId = s?.recipe_id || null;
      if (!recipeId) {
        let generated = s?.generated_recipe || null;
        const generatedIngredients = Array.isArray(generated?.ingredients)
          ? generated.ingredients
          : [];
        if (s?.free_text && generatedIngredients.length === 0) {
          try {
            const preview = await buildPreviewFromTitle(s.free_text, s?.people);
            generated = preview;
            s.generated_recipe = preview;
            s.generated_recipe_people_signature = peopleSignature(s?.people);
            weekChanged = true;
          } catch {
            // ignore and fall back to missing list
          }
        }
        const finalIngredients = Array.isArray(generated?.ingredients)
          ? generated.ingredients
          : [];
        if (finalIngredients.length > 0) {
          for (const ing of finalIngredients) {
            const item = String(ing?.item || "").trim();
            if (!item) continue;
            const unit = String(ing?.unit || "").trim();
            const qtyRaw = String(ing?.qty || "").trim();
            const key = `${normalizeIngredientKey(item)}|${normalizeIngredientKey(unit)}`;
            if (!itemsMap.has(key)) {
              itemsMap.set(key, {
                item,
                unit,
                qtys: [],
                recipes: new Set()
              });
            }
            const entry = itemsMap.get(key);
            if (qtyRaw) entry.qtys.push(qtyRaw);
            entry.recipes.add(s?.free_text || slot);
          }
        } else if (s?.free_text) {
          missingRecipes.push({ slot, title: s.free_text });
        }
        continue;
      }
      if (usedRecipes.has(recipeId)) continue;
      usedRecipes.add(recipeId);
      let recipe = null;
      try {
        recipe = await readJson(path.join(RECIPES_DIR, `${recipeId}.json`));
      } catch {
        missingRecipes.push({ slot, title: recipeId });
        continue;
      }
      const ingredients = Array.isArray(recipe?.content?.ingredients)
        ? recipe.content.ingredients
        : [];
      for (const ing of ingredients) {
        const item = String(ing?.item || "").trim();
        if (!item) continue;
        const unit = String(ing?.unit || "").trim();
        const qtyRaw = String(ing?.qty || "").trim();
        const key = `${normalizeIngredientKey(item)}|${normalizeIngredientKey(unit)}`;
        if (!itemsMap.has(key)) {
          itemsMap.set(key, {
            item,
            unit,
            qtys: [],
            recipes: new Set()
          });
        }
        const entry = itemsMap.get(key);
        if (qtyRaw) entry.qtys.push(qtyRaw);
        entry.recipes.add(recipe?.title || recipeId);
      }
    }

    const items = [];
    for (const entry of itemsMap.values()) {
      const qtyNums = entry.qtys.map(parseQty).filter((v) => v != null);
      let qty = "";
      if (qtyNums.length === entry.qtys.length && qtyNums.length > 0) {
        const sum = qtyNums.reduce((a, b) => a + b, 0);
        qty = String(sum);
      } else if (entry.qtys.length > 0) {
        qty = Array.from(new Set(entry.qtys)).join(" + ");
      }
      items.push({
        item: entry.item,
        unit: entry.unit,
        qty,
        recipes: Array.from(entry.recipes)
      });
    }

    items.sort((a, b) => a.item.localeCompare(b.item));

    if (weekChanged) {
      week.updated_at = nowIso();
      await writeJson(path.join(WEEKS_DIR, `${week.week_id}.json`), week);
    }

    res.json({
      ok: true,
      week_id: week.week_id,
      items,
      missing_recipes: missingRecipes,
      week
    });
  } catch (e) {
    const status = e?.code === "ENOENT" ? 404 : 500;
    res.status(status).json({ error: "shopping_list_failed", details: e.message });
  }
});

/**
 * GET /api/weeks/:week_id
 * IMPORTANT: doit etre APRES /current, /list, /prepare, /:week_id/constraints, /:week_id/slots/:slot
 */
router.get("/:week_id", async (req, res) => {
  try {
    const week = await loadWeek(req.params.week_id);
    const hasActiveSlots =
      Array.isArray(week?.rules_readonly?.active_slots) &&
      week.rules_readonly.active_slots.length > 0;
    if (!hasActiveSlots && week?.date_start && week?.date_end) {
      const activeSlots = activeSlotsFromRange(week.date_start, week.date_end);
      week.rules_readonly = {
        ...(week.rules_readonly || {}),
        active_slots: activeSlots
      };
      week.updated_at = nowIso();
      await writeJson(path.join(WEEKS_DIR, `${week.week_id}.json`), week);
    }
    res.json(week);
  } catch (e) {
    const status = e?.code === "ENOENT" ? 404 : 500;
    res.status(status).json({ error: "week_read_failed", details: e.message });
  }
});

/**
 * PATCH /api/weeks/:week_id/pantry
 * body: { pantry_checked: { [key]: boolean } }
 * Persists pantry checklist per week.
 */
router.patch("/:week_id/pantry", async (req, res) => {
  try {
    const weekId = String(req.params.week_id || "").trim();
    if (!weekId) return res.status(400).json({ error: "missing_week_id" });
    if (!isValidWeekId(weekId)) {
      return res.status(400).json({ error: "invalid_week_id" });
    }

    const pantry = req.body?.pantry_checked;
    if (!pantry || typeof pantry !== "object") {
      return res.status(400).json({ error: "missing_pantry_checked" });
    }

    const p = path.join(WEEKS_DIR, `${weekId}.json`);
    const week = await safeReadJson(p);
    if (!week) return res.status(404).json({ error: "week_not_found" });

    week.pantry_checked = pantry;
    week.updated_at = nowIso();
    await writeJson(p, week);

    return res.json({ ok: true, week_id: weekId, pantry_checked: pantry });
  } catch (e) {
    return res.status(500).json({ error: "week_pantry_failed", details: e.message });
  }
});

export default router;
