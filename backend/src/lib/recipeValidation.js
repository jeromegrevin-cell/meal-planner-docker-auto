const STATUS_ENUM = new Set(["DRAFT", "VALIDEE", "A_MODIFIER", "REJETEE", "EXTERNE"]);
const SOURCE_TYPES = new Set(["LOCAL", "DRIVE", "MENU_VALIDATED", "CHAT"]);
const RECIPE_ID_RE = /^rcp_[A-Za-z0-9_-]+$/;

function isNonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlaceholderTitle(title) {
  if (!isNonEmptyString(title)) return true;
  return title.toLowerCase().includes("placeholder");
}

function validateRecipe(recipe, { requireContent = false } = {}) {
  const errors = [];

  if (!recipe || typeof recipe !== "object") {
    return { ok: false, errors: ["recipe_missing"] };
  }

  if (!isNonEmptyString(recipe.recipe_id) || !RECIPE_ID_RE.test(recipe.recipe_id)) {
    errors.push("invalid_recipe_id");
  }

  if (!isNonEmptyString(recipe.title)) {
    errors.push("missing_title");
  } else if (isPlaceholderTitle(recipe.title)) {
    errors.push("placeholder_title");
  }

  if (!STATUS_ENUM.has(recipe.status)) {
    errors.push("invalid_status");
  }

  const source = recipe.source || {};
  if (!isNonEmptyString(source.type) || !SOURCE_TYPES.has(source.type)) {
    errors.push("invalid_source_type");
  }

  if (source.type === "DRIVE") {
    if (!isNonEmptyString(source.drive_path)) {
      errors.push("missing_drive_path");
    } else if (String(source.drive_path).startsWith("drive://stub/")) {
      errors.push("stub_drive_path");
    }
  }

  if (!Number.isFinite(recipe.servings) || recipe.servings < 1) {
    errors.push("invalid_servings");
  }

  if (!Array.isArray(recipe.season) || recipe.season.length === 0) {
    errors.push("invalid_season");
  }

  if (recipe.notes != null && typeof recipe.notes !== "string") {
    errors.push("invalid_notes");
  }

  const content = recipe.content || {};
  if (typeof content !== "object" || content === null) {
    errors.push("invalid_content");
  } else {
    if (content.description_courte != null && typeof content.description_courte !== "string") {
      errors.push("invalid_description_courte");
    }

    const ingredients = Array.isArray(content.ingredients) ? content.ingredients : [];
    const steps = Array.isArray(content.preparation_steps) ? content.preparation_steps : [];

    if (requireContent) {
      if (ingredients.length === 0) errors.push("missing_ingredients");
      if (steps.length === 0) errors.push("missing_steps");
    }

    for (const ing of ingredients) {
      if (!ing || typeof ing !== "object") {
        errors.push("invalid_ingredient_row");
        continue;
      }
      if (!isNonEmptyString(ing.item)) errors.push("invalid_ingredient_item");
      if (!isNonEmptyString(ing.qty)) errors.push("invalid_ingredient_qty");
      if (!isNonEmptyString(ing.unit)) errors.push("invalid_ingredient_unit");
    }

    for (const step of steps) {
      if (!isNonEmptyString(step)) errors.push("invalid_step");
    }
  }

  return { ok: errors.length === 0, errors };
}

export { validateRecipe, isPlaceholderTitle, STATUS_ENUM, SOURCE_TYPES };
