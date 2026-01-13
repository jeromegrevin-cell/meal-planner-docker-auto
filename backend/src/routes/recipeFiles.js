import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { readJson, writeJson } from "../lib/jsonStore.js";

const router = express.Router();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const RECIPES_DIR = path.join(__dirname, "../../data/recipes");

const STATUS_ENUM = new Set(["DRAFT", "VALIDEE", "A_MODIFIER", "REJETEE", "EXTERNE"]);

function recipePath(id) {
  return path.join(RECIPES_DIR, `${id}.json`);
}
function nowIso() {
  return new Date().toISOString();
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

router.get("/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const recipe = await readJson(recipePath(id));
    return res.json(recipe);
  } catch (e) {
    if (e?.code === "ENOENT") return res.status(404).json({ error: "recipe_not_found", recipe_id: id });
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
