import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { isValidWeekId, resolveUploadPdfPath } from "../src/lib/validators.js";

test("isValidWeekId accepts strict YYYY-WNN", () => {
  assert.equal(isValidWeekId("2026-W08"), true);
  assert.equal(isValidWeekId("2026-W01"), true);
  assert.equal(isValidWeekId("2026-W99"), true);

  assert.equal(isValidWeekId("2026-W8"), false);
  assert.equal(isValidWeekId("2026-W00"), false);
  assert.equal(isValidWeekId("2026-W100"), false);
  assert.equal(isValidWeekId("../2026-W08"), false);
  assert.equal(isValidWeekId("2026-W08/../../x"), false);
  assert.equal(isValidWeekId("2026-W08.json"), false);
});

test("resolveUploadPdfPath allows only the expected PDF", () => {
  const pdfDir = path.resolve("/tmp/meal-planner-pdfs");
  const recipeId = "rcp_123";
  const expected = path.resolve(pdfDir, `${recipeId}.pdf`);

  assert.equal(resolveUploadPdfPath(pdfDir, recipeId), expected);
  assert.equal(resolveUploadPdfPath(pdfDir, recipeId, expected), expected);
  assert.throws(
    () => resolveUploadPdfPath(pdfDir, recipeId, "/etc/passwd"),
    /pdf_path_not_allowed/
  );
  assert.throws(
    () => resolveUploadPdfPath(pdfDir, recipeId, path.join(pdfDir, "other.pdf")),
    /pdf_path_not_allowed/
  );
});

