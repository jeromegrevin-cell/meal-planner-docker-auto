import express from "express";
import path from "path";
import fs from "fs/promises";
import { fileURLToPath } from "url";
import { readJson, writeJson } from "../lib/jsonStore.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RECIPES_DIR = path.join(__dirname, "../../data/recipes");
const PDFS_DIR = path.join(__dirname, "../../pdfs");
const ROOT_DIR = path.resolve(__dirname, "../../..");
const DRIVE_INDEX = path.join(ROOT_DIR, "recettes_index.json");

const STATUS_ENUM = new Set(["DRAFT", "VALIDEE", "A_MODIFIER", "REJETEE", "EXTERNE"]);

function recipePath(id) {
  return path.join(RECIPES_DIR, `${id}.json`);
}
function nowIso() {
  return new Date().toISOString();
}

function newRecipeId() {
  const stamp = Date.now();
  const rand = Math.random().toString(16).slice(2, 8);
  return `rcp_${stamp}_${rand}`;
}

function normalizeTitle(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const TITLE_STOP_WORDS = new Set([
  "de", "du", "des", "la", "le", "les", "au", "aux", "a", "et", "en",
  "d", "l", "un", "une", "avec", "sans"
]);

function titleKey(s) {
  const base = normalizeTitle(s);
  if (!base) return "";
  const tokens = base.split(" ").filter((t) => t && !TITLE_STOP_WORDS.has(t));
  tokens.sort();
  return tokens.join(" ");
}

async function loadDriveIndex() {
  try {
    return await readJson(DRIVE_INDEX);
  } catch (_e) {
    return null;
  }
}

async function findTitleConflicts(title) {
  const norm = normalizeTitle(title);
  const key = titleKey(title);
  const index = await loadDriveIndex();
  if (!Array.isArray(index)) return { exact: [], near: [] };

  const exact = [];
  const near = [];
  for (const item of index) {
    const n = item?.normalized_title || normalizeTitle(item?.title || "");
    const k = item?.title_key || titleKey(item?.title || "");
    if (!n && !k) continue;
    if (n && n === norm) {
      exact.push({
        title: item.title,
        file_id: item.file_id,
        fullPath: item.fullPath,
        webViewLink: item.webViewLink
      });
    } else if (k && k === key) {
      near.push({
        title: item.title,
        file_id: item.file_id,
        fullPath: item.fullPath,
        webViewLink: item.webViewLink
      });
    }
  }
  return { exact, near };
}

async function generatePdfStub(recipeId, title) {
  await fs.mkdir(PDFS_DIR, { recursive: true });
  const pdfPath = path.join(PDFS_DIR, `${recipeId}.pdf`);
  const content = `PDF stub for ${recipeId}\n${title}\n`;
  await fs.writeFile(pdfPath, content, "utf-8");
  return pdfPath;
}

async function saveRecipeJson({ title, source, people, preview }) {
  await fs.mkdir(RECIPES_DIR, { recursive: true });
  const recipe_id = newRecipeId();
  const totalPeople =
    Number(people?.adults || 0) + Number(people?.children || 0) || 3;

  const recipe = {
    recipe_id,
    title: String(title || ""),
    source: source || { type: "LOCAL", drive_path: "", origin: "CHAT" },
    status: "DRAFT",
    servings: totalPeople,
    season: ["hiver"],
    main_ingredient: "",
    notes: "",
    content: {
      description_courte: preview?.description_courte || "",
      ingredients: Array.isArray(preview?.ingredients) ? preview.ingredients : [],
      preparation_steps: Array.isArray(preview?.preparation_steps)
        ? preview.preparation_steps
        : []
    },
    updated_at: nowIso()
  };

  await writeJson(recipePath(recipe_id), recipe);
  return recipe;
}

async function uploadPdfStub(recipe, pdfPath) {
  // Stub: in real pipeline, upload to Drive and set real drive_path.
  const drive_path = `drive://stub/${recipe.recipe_id}`;
  recipe.source = { type: "DRIVE", drive_path };
  recipe.status = "EXTERNE";
  recipe.updated_at = nowIso();
  await writeJson(recipePath(recipe.recipe_id), recipe);
  return drive_path;
}

function applyRecipePatch(recipe, patch) {
  const allowedTop = new Set(["notes", "content"]);
  for (const k of Object.keys(patch)) {
    if (!allowedTop.has(k)) throw new Error(`field_not_allowed:${k}`);
  }

  if ("notes" in patch) {
    if (typeof patch.notes !== "string") throw new Error("invalid_notes");
    recipe.notes = patch.notes;
  }

  if ("content" in patch) {
    if (typeof patch.content !== "object" || patch.content === null) throw new Error("invalid_content");

    const allowedContent = new Set(["ingredients", "preparation_steps", "description_courte"]);
    for (const ck of Object.keys(patch.content)) {
      if (!allowedContent.has(ck)) throw new Error(`content_field_not_allowed:${ck}`);
    }

    recipe.content = recipe.content || {};

    if ("description_courte" in patch.content) {
      if (typeof patch.content.description_courte !== "string") throw new Error("invalid_description_courte");
      recipe.content.description_courte = patch.content.description_courte;
    }

    if ("ingredients" in patch.content) {
      if (!Array.isArray(patch.content.ingredients)) throw new Error("invalid_ingredients");
      for (const ing of patch.content.ingredients) {
        if (!ing || typeof ing !== "object") throw new Error("invalid_ingredient_row");
        if (typeof ing.item !== "string") throw new Error("invalid_ingredient_item");
        if (typeof ing.qty !== "string") throw new Error("invalid_ingredient_qty");
        if (typeof ing.unit !== "string") throw new Error("invalid_ingredient_unit");
      }
      recipe.content.ingredients = patch.content.ingredients;
    }

    if ("preparation_steps" in patch.content) {
      if (!Array.isArray(patch.content.preparation_steps)) throw new Error("invalid_preparation_steps");
      for (const s of patch.content.preparation_steps) {
        if (typeof s !== "string") throw new Error("invalid_preparation_step");
      }
      recipe.content.preparation_steps = patch.content.preparation_steps;
    }
  }

  recipe.updated_at = nowIso();
  return recipe;
}

/**
 * POST /api/recipes/save
 * body: { title, week_id?, slot?, source?, people?, preview? }
 * Creates recipe JSON + PDF stub. Blocks on duplicates.
 */
router.post("/save", async (req, res) => {
  const title = String(req.body?.title || "").trim();
  const source = req.body?.source || { type: "LOCAL", drive_path: "", origin: "CHAT" };
  const people = req.body?.people || null;
  const preview = req.body?.preview || null;

  if (!title) return res.status(400).json({ error: "missing_title" });

  const conflicts = await findTitleConflicts(title);
  if (conflicts.exact.length || conflicts.near.length) {
    return res.status(409).json({
      error: "duplicate_title",
      conflicts
    });
  }

  try {
    const recipe = await saveRecipeJson({ title, source, people, preview });
    const pdf_path = await generatePdfStub(recipe.recipe_id, recipe.title);
    return res.json({ ok: true, recipe_id: recipe.recipe_id, pdf_path, recipe });
  } catch (e) {
    return res.status(500).json({ error: "recipe_save_failed", details: e.message });
  }
});

/**
 * POST /api/recipes/upload
 * body: { recipe_id, pdf_path? }
 * Blocks on duplicates, then stub "upload".
 */
router.post("/upload", async (req, res) => {
  const recipe_id = String(req.body?.recipe_id || "").trim();
  if (!recipe_id) return res.status(400).json({ error: "missing_recipe_id" });

  try {
    const recipe = await readJson(recipePath(recipe_id));
    const conflicts = await findTitleConflicts(recipe.title || "");
    if (conflicts.exact.length || conflicts.near.length) {
      return res.status(409).json({ error: "duplicate_title", conflicts });
    }

    const pdf_path = String(req.body?.pdf_path || path.join(PDFS_DIR, `${recipe_id}.pdf`));
    const drive_path = await uploadPdfStub(recipe, pdf_path);
    return res.json({ ok: true, recipe_id, drive_path });
  } catch (e) {
    const status = e?.code === "ENOENT" ? 404 : 500;
    return res.status(status).json({ error: "recipe_upload_failed", details: e.message });
  }
});

/**
 * POST /api/recipes/save-and-upload
 * body: { title, week_id?, slot?, source?, people?, preview? }
 * Save -> duplicate check -> upload.
 */
router.post("/save-and-upload", async (req, res) => {
  const title = String(req.body?.title || "").trim();
  const source = req.body?.source || { type: "LOCAL", drive_path: "", origin: "CHAT" };
  const people = req.body?.people || null;
  const preview = req.body?.preview || null;

  if (!title) return res.status(400).json({ error: "missing_title" });

  const conflicts = await findTitleConflicts(title);
  if (conflicts.exact.length || conflicts.near.length) {
    return res.status(409).json({ error: "duplicate_title", conflicts });
  }

  try {
    const recipe = await saveRecipeJson({ title, source, people, preview });
    const pdf_path = await generatePdfStub(recipe.recipe_id, recipe.title);
    const drive_path = await uploadPdfStub(recipe, pdf_path);
    return res.json({
      ok: true,
      recipe_id: recipe.recipe_id,
      pdf_path,
      drive_path
    });
  } catch (e) {
    return res.status(500).json({ error: "recipe_save_upload_failed", details: e.message });
  }
});

router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const recipe = await readJson(recipePath(id));
    return res.json(recipe);
  } catch (e) {
    if (e?.code === "ENOENT") {
      return res.status(404).json({ error: "recipe_not_found", recipe_id: id });
    }
    return res.status(500).json({ error: "recipe_read_failed", details: e.message });
  }
});

router.patch("/:id/status", async (req, res) => {
  const { id } = req.params;
  const { status } = req.body || {};

  if (!STATUS_ENUM.has(status)) {
    return res.status(400).json({ error: "invalid_status", allowed: Array.from(STATUS_ENUM) });
  }

  try {
    const p = recipePath(id);
    const recipe = await readJson(p);
    recipe.status = status;
    recipe.updated_at = nowIso();
    await writeJson(p, recipe);
    return res.json(recipe);
  } catch (e) {
    if (e?.code === "ENOENT") return res.status(404).json({ error: "recipe_not_found", recipe_id: id });
    return res.status(500).json({ error: "recipe_write_failed", details: e.message });
  }
});

router.patch("/:id", async (req, res) => {
  const { id } = req.params;
  const patch = req.body || {};

  try {
    const p = recipePath(id);
    const recipe = await readJson(p);
    const updated = applyRecipePatch(recipe, patch);
    await writeJson(p, updated);
    return res.json(updated);
  } catch (e) {
    const msg = String(e?.message || "");
    if (e?.code === "ENOENT") return res.status(404).json({ error: "recipe_not_found", recipe_id: id });

    if (msg.startsWith("field_not_allowed:") || msg.startsWith("content_field_not_allowed:")) {
      return res.status(400).json({ error: "patch_denied", details: msg });
    }
    if (msg.startsWith("invalid_")) {
      return res.status(400).json({ error: "invalid_patch", details: msg });
    }
    return res.status(500).json({ error: "recipe_patch_failed", details: msg });
  }
});

export default router;
