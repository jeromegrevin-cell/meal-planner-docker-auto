import path from "path";

export function isValidWeekId(weekId) {
  if (typeof weekId !== "string") return false;
  const m = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!m) return false;
  const weekNum = Number(m[2]);
  return Number.isInteger(weekNum) && weekNum >= 1 && weekNum <= 99;
}

export function resolveUploadPdfPath(pdfsDir, recipeId, requestedPath) {
  const expected = path.resolve(pdfsDir, `${recipeId}.pdf`);
  if (!requestedPath) return expected;
  const candidate = path.resolve(String(requestedPath));
  if (candidate !== expected) {
    const err = new Error("pdf_path_not_allowed");
    err.code = "pdf_path_not_allowed";
    throw err;
  }
  return candidate;
}

