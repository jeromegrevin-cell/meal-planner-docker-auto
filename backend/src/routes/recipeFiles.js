import express from "express";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";
import os from "os";
import fsSync from "fs";
import { fileURLToPath } from "url";
import { readJson, writeJson } from "../lib/jsonStore.js";
import { DATA_DIR, PROJECT_ROOT } from "../lib/dataPaths.js";
import { validateRecipe } from "../lib/recipeValidation.js";
import { updateLastUpload } from "../lib/driveState.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RECIPES_DIR = path.join(DATA_DIR, "recipes");
const PDFS_DIR = path.join(__dirname, "../../pdfs");
const ROOT_DIR = PROJECT_ROOT;
const DRIVE_INDEX = path.join(ROOT_DIR, "recettes_index.json");

const STATUS_ENUM = new Set(["DRAFT", "VALIDEE", "A_MODIFIER", "REJETEE", "EXTERNE"]);
const RECIPE_ID_RE = /^rcp_[A-Za-z0-9_-]+$/;

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

function isValidRecipeId(id) {
  return typeof id === "string" && RECIPE_ID_RE.test(id);
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

function filterDriveIndex(index, status) {
  if (!Array.isArray(index)) return [];
  if (!status || status === "ALL") return index;
  return index.filter((item) => String(item?.parse_status || "") === status);
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
        webViewLink: item.webViewLink,
        parse_status: item.parse_status || null
      });
    } else if (k && k === key) {
      near.push({
        title: item.title,
        file_id: item.file_id,
        fullPath: item.fullPath,
        webViewLink: item.webViewLink,
        parse_status: item.parse_status || null
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

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch (_e) {
    return false;
  }
}

async function resolvePythonBin() {
  const fromEnv = (process.env.PYTHON_BIN || "").trim();
  if (fromEnv) return fromEnv;
  const candidates = [
    path.join(ROOT_DIR, ".venv", "bin", "python"),
    path.join(process.cwd(), ".venv", "bin", "python"),
    "python3",
    "python"
  ];
  for (const p of candidates) {
    if (p.startsWith("python")) return p;
    if (await fileExists(p)) return p;
  }
  return "python3";
}

async function resolveCredentialsPath() {
  const envPath = (process.env.GOOGLE_APPLICATION_CREDENTIALS || "").trim();
  if (envPath && (await fileExists(envPath))) return envPath;
  const secretsDir = (process.env.MEAL_PLANNER_SECRETS_DIR || "").trim();
  if (secretsDir) {
    const p = path.join(
      secretsDir,
      "service_accounts",
      "chatgpt-recettes-access.json"
    );
    if (await fileExists(p)) return p;
  }
  const fallbackDir = path.join(os.homedir(), "meal-planner-secrets");
  const fallbackPath = path.join(
    fallbackDir,
    "service_accounts",
    "chatgpt-recettes-access.json"
  );
  if (await fileExists(fallbackPath)) return fallbackPath;
  return null;
}

async function resolveUploadScriptPath() {
  const candidates = [
    path.join(ROOT_DIR, "drive_recettes_upload.py"),
    path.join(ROOT_DIR, "scripts", "drive_recettes_upload.py")
  ];
  for (const p of candidates) {
    if (await fileExists(p)) return p;
  }
  return candidates[0];
}

async function uploadPdfToDrive({ title, pdfPath }) {
  const scriptPath = await resolveUploadScriptPath();
  const pythonBin = await resolvePythonBin();
  const credentialsPath = await resolveCredentialsPath();
  if (!credentialsPath) {
    throw new Error("missing_service_account");
  }

  const env = { ...process.env };
  env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
  if (!env.MEAL_PLANNER_SECRETS_DIR && credentialsPath) {
    const secretsDir = path.dirname(path.dirname(credentialsPath));
    env.MEAL_PLANNER_SECRETS_DIR = secretsDir;
  }

  const command = `${pythonBin} -u "${scriptPath}" --pdf "${pdfPath}" --title "${title}"`;
  return new Promise((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: ROOT_DIR,
      env
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => reject(err));
    child.on("close", (code) => {
      const out = stdout.trim();
      if (code !== 0) {
        return reject(
          new Error(`drive_upload_failed:${stderr || out || `exit_code:${code}`}`)
        );
      }
      let payload = null;
      try {
        payload = JSON.parse(out);
      } catch (_e) {
        return reject(new Error(`drive_upload_parse_failed:${out}`));
      }
      if (!payload?.ok) {
        return reject(new Error(payload?.error || "drive_upload_failed"));
      }
      return resolve(payload);
    });
  });
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
  if (!preview) return res.status(400).json({ error: "missing_preview" });

  const conflicts = await findTitleConflicts(title);
  if (conflicts.exact.length || conflicts.near.length) {
    return res.status(409).json({
      error: "duplicate_title",
      conflicts
    });
  }

  try {
    const recipe = await saveRecipeJson({ title, source, people, preview });
    const validation = validateRecipe(recipe, { requireContent: true });
    if (!validation.ok) {
      return res.status(400).json({ error: "invalid_recipe", details: validation.errors });
    }
    const pdf_path = await generatePdfStub(recipe.recipe_id, recipe.title);
    return res.json({ ok: true, recipe_id: recipe.recipe_id, pdf_path, recipe });
  } catch (e) {
    return res.status(500).json({ error: "recipe_save_failed", details: e.message });
  }
});

/**
 * GET /api/recipes/drive?status=CONFIDENT|INCOMPLETE|ALL
 * Returns Drive index entries (filtered by parse_status by default).
 */
router.get("/drive", async (req, res) => {
  try {
    const status = String(req.query?.status || "CONFIDENT").toUpperCase();
    const index = await loadDriveIndex();
    const filtered = filterDriveIndex(index, status);

    const out = filtered.map((item) => ({
      title: item.title,
      file_id: item.file_id,
      mimeType: item.mimeType,
      parse_status: item.parse_status || null,
      parse_notes: item.parse_notes || [],
      webViewLink: item.webViewLink || null
    }));

    res.json({ ok: true, status, count: out.length, items: out });
  } catch (e) {
    res.status(500).json({ ok: false, error: "drive_index_failed", details: e.message });
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
    const validation = validateRecipe(recipe, { requireContent: true });
    if (!validation.ok) {
      return res.status(400).json({ error: "invalid_recipe", details: validation.errors });
    }
    const conflicts = await findTitleConflicts(recipe.title || "");
    if (conflicts.exact.length || conflicts.near.length) {
      return res.status(409).json({ error: "duplicate_title", conflicts });
    }

    const pdf_path = String(req.body?.pdf_path || path.join(PDFS_DIR, `${recipe_id}.pdf`));
    if (!fsSync.existsSync(pdf_path)) {
      return res.status(404).json({ error: "pdf_not_found", pdf_path });
    }
    const upload = await uploadPdfToDrive({ title: recipe.title || recipe_id, pdfPath: pdf_path });
    const drive_path = upload.drive_path || "";
    recipe.source = {
      ...(recipe.source || {}),
      type: "DRIVE",
      drive_path,
      origin: recipe.source?.origin || "UPLOAD"
    };
    recipe.updated_at = nowIso();
    await writeJson(recipePath(recipe_id), recipe);
    await updateLastUpload();
    return res.json({
      ok: true,
      recipe_id,
      drive_path,
      file_id: upload.file_id || null,
      webViewLink: upload.webViewLink || null,
      already_exists: Boolean(upload.already_exists)
    });
  } catch (e) {
    const status = e?.code === "ENOENT"
      ? 404
      : String(e?.message || "").includes("missing_service_account")
        ? 500
        : 500;
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
  if (!preview) return res.status(400).json({ error: "missing_preview" });

  const conflicts = await findTitleConflicts(title);
  if (conflicts.exact.length || conflicts.near.length) {
    return res.status(409).json({ error: "duplicate_title", conflicts });
  }

  try {
    const recipe = await saveRecipeJson({ title, source, people, preview });
    const validation = validateRecipe(recipe, { requireContent: true });
    if (!validation.ok) {
      return res.status(400).json({ error: "invalid_recipe", details: validation.errors });
    }
    const pdf_path = await generatePdfStub(recipe.recipe_id, recipe.title);
    const upload = await uploadPdfToDrive({ title: recipe.title || recipe.recipe_id, pdfPath: pdf_path });
    const drive_path = upload.drive_path || "";
    recipe.source = {
      ...(recipe.source || {}),
      type: "DRIVE",
      drive_path,
      origin: recipe.source?.origin || "UPLOAD"
    };
    recipe.updated_at = nowIso();
    await writeJson(recipePath(recipe.recipe_id), recipe);
    await updateLastUpload();
    return res.json({
      ok: true,
      recipe_id: recipe.recipe_id,
      pdf_path,
      drive_path,
      file_id: upload.file_id || null,
      webViewLink: upload.webViewLink || null,
      already_exists: Boolean(upload.already_exists)
    });
  } catch (e) {
    const status = String(e?.message || "").includes("missing_service_account") ? 500 : 500;
    return res.status(status).json({ error: "recipe_save_upload_failed", details: e.message });
  }
});

router.get("/:id", async (req, res) => {
  const { id } = req.params;
  if (!isValidRecipeId(id)) {
    return res.status(400).json({ error: "invalid_recipe_id" });
  }
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

  if (!isValidRecipeId(id)) {
    return res.status(400).json({ error: "invalid_recipe_id" });
  }
  if (!STATUS_ENUM.has(status)) {
    return res.status(400).json({ error: "invalid_status", allowed: Array.from(STATUS_ENUM) });
  }

  try {
    const p = recipePath(id);
    const recipe = await readJson(p);
    recipe.status = status;
    if (status === "VALIDEE" || status === "EXTERNE") {
      const validation = validateRecipe(recipe, { requireContent: true });
      if (!validation.ok) {
        return res.status(400).json({ error: "invalid_recipe", details: validation.errors });
      }
    }
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

  if (!isValidRecipeId(id)) {
    return res.status(400).json({ error: "invalid_recipe_id" });
  }
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
