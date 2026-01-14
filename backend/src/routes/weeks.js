import express from "express";
import path from "path";
import fs from "fs/promises";
import { readJson, writeJson } from "../lib/jsonStore.js";

const router = express.Router();

const WEEKS_DIR = path.join(process.cwd(), "data", "weeks");
const RECIPES_DIR = path.join(process.cwd(), "data", "recipes");

function nowIso() {
  return new Date().toISOString();
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
  // YYYY-WNN
  if (typeof weekId !== "string") return false;
  const m = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return false;
  const weekNum = Number(m[2]);
  return Number.isInteger(weekNum) && weekNum >= 1 && weekNum <= 53;
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
    status: "DRAFT",
    servings: 3,
    season: ["hiver"],
    main_ingredient: "",
    notes: "",
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
 * Cree la semaine si absente, et cree aussi les recipes placeholders si besoin.
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
        details:
          "Expected format YYYY-WNN with NN between 01 and 53 (e.g., 2026-W03)"
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

    // Si existant (même si ancien): renvoyer (comportement identique)
    const existing = await safeReadJson(p);
    if (existing) {
      return res.status(200).json({ created: false, week: existing });
    }

    const week = {
      week_id: weekId,
      date_start: dateStart,
      date_end: dateEnd,
      timezone: "Europe/Paris",
      rules_readonly: {
        no_lunch_slots: ["mon_lunch", "tue_lunch", "thu_lunch", "fri_lunch"],
        main_ingredient_max_per_week: 2,
        main_ingredient_min_day_gap_if_used_twice: 2,
        seasonality_required: true
      },
      slots: {
        mon_dinner: { recipe_id: "rcp_0001" },
        tue_dinner: { recipe_id: "rcp_0002" },
        wed_lunch: { recipe_id: "rcp_0003" },
        wed_dinner: { recipe_id: "rcp_0004" },
        thu_dinner: { recipe_id: "rcp_0005" },
        fri_dinner: { recipe_id: "rcp_0006" },
        sat_lunch: { recipe_id: "rcp_0003" },
        sat_dinner: { recipe_id: "rcp_0002" },
        sun_lunch: { recipe_id: "rcp_0004" },
        sun_dinner: { recipe_id: "rcp_0001" }
      },
      updated_at: nowIso()
    };

    // creer aussi les recettes si absentes
    const recipeIds = [
      ...new Set(Object.values(week.slots).map((s) => s.recipe_id))
    ];
    for (const rid of recipeIds) {
      await ensureRecipeExists(rid);
    }

    await writeJson(p, week);
    res.status(201).json({ created: true, week });
  } catch (e) {
    res.status(500).json({ error: "week_prepare_failed", details: e.message });
  }
});

/**
 * PATCH /api/weeks/:week_id/slots/:slot
 * body: { recipe_id?: string|null, free_text?: string|null }
 * - Permet "Valider" une proposition (recipe_id et/ou free_text)
 * - Stocke free_text dans week.slots[slot].free_text
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

    week.updated_at = nowIso();
    await writeJson(p, week);

    res.json({ ok: true, week });
  } catch (e) {
    res.status(500).json({ error: "week_slot_patch_failed", details: e.message });
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
 * GET /api/weeks/:week_id
 * IMPORTANT: doit etre APRES /current, /list, /prepare, /:week_id/constraints, /:week_id/slots/:slot
 */
router.get("/:week_id", async (req, res) => {
  try {
    const week = await loadWeek(req.params.week_id);
    res.json(week);
  } catch (e) {
    const status = e?.code === "ENOENT" ? 404 : 500;
    res.status(status).json({ error: "week_read_failed", details: e.message });
  }
});

export default router;
