import { promises as fs } from "fs";
import path from "path";
import { readJson, writeJson } from "../src/lib/jsonStore.js";
import { validateRecipe } from "../src/lib/recipeValidation.js";

const RECIPES_DIR = path.join(process.cwd(), "data", "recipes");

function isFixMode() {
  return process.argv.includes("--fix");
}

async function listJsonFiles(dirPath) {
  try {
    const entries = await fs.readdir(dirPath);
    return entries.filter((f) => f.toLowerCase().endsWith(".json"));
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
}

function nowIso() {
  return new Date().toISOString();
}

async function main() {
  const fix = isFixMode();
  const files = await listJsonFiles(RECIPES_DIR);

  if (files.length === 0) {
    console.log("No recipes to validate.");
    return;
  }

  let invalid = 0;

  for (const file of files) {
    const p = path.join(RECIPES_DIR, file);
    const recipe = await readJson(p);
    const validation = validateRecipe(recipe, { requireContent: true });

    if (validation.ok) continue;

    invalid += 1;
    console.log(`INVALID ${file}: ${validation.errors.join(", ")}`);

    if (fix) {
      recipe.status = "A_MODIFIER";
      const note = `validation_errors:${validation.errors.join("|")}`;
      const existingNotes = String(recipe.notes || "");
      recipe.notes = existingNotes ? `${existingNotes}\n${note}` : note;
      recipe.updated_at = nowIso();
      await writeJson(p, recipe);
      console.log(`  -> status set to A_MODIFIER`);
    }
  }

  if (invalid > 0) {
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error("validate-recipes failed:", e?.stack || e?.message || String(e));
  process.exit(2);
});
