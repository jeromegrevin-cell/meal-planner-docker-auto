// src/routes/health.js
import express from "express";
import { promises as fs } from "fs";
import path from "path";
import { DATA_DIR } from "../lib/dataPaths.js";

const router = express.Router();

const TARGET_DIRS = [path.join(DATA_DIR, "weeks"), path.join(DATA_DIR, "recipes")];

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

async function listJsonFiles(dirPath) {
  const files = [];

  async function walk(current) {
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch (e) {
      if (e?.code === "ENOENT") return;
      throw e;
    }

    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) await walk(full);
      else if (ent.isFile() && ent.name.toLowerCase().endsWith(".json")) files.push(full);
    }
  }

  await walk(dirPath);
  return files;
}

async function checkOne(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (e) {
    return { status: "CORRUPT", error: `read_failed: ${e?.message || String(e)}` };
  }

  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return { status: "EMPTY" };

  try {
    JSON.parse(trimmed);
    return { status: "OK" };
  } catch (e) {
    return { status: "CORRUPT", error: e?.message || String(e) };
  }
}

function rel(p) {
  return path.relative(process.cwd(), p) || p;
}

/**
 * GET /api/health/data
 * Optional query:
 * - ?verbose=1  -> include OK files count per dir
 */
router.get("/data", async (req, res) => {
  try {
    const verbose = String(req.query?.verbose || "") === "1";

    const results = {
      ok: true,
      checked_at: new Date().toISOString(),
      dirs: {},
      issues: []
    };

    for (const d of TARGET_DIRS) {
      const absDir = path.join(process.cwd(), d);
      const dirExists = await exists(absDir);

      results.dirs[d] = {
        exists: dirExists,
        scanned: 0,
        ok: 0,
        empty: 0,
        corrupt: 0
      };

      if (!dirExists) continue;

      const files = await listJsonFiles(absDir);
      results.dirs[d].scanned = files.length;

      for (const f of files) {
        const r = await checkOne(f);

        if (r.status === "OK") {
          results.dirs[d].ok += 1;
          continue;
        }

        results.ok = false;

        if (r.status === "EMPTY") results.dirs[d].empty += 1;
        if (r.status === "CORRUPT") results.dirs[d].corrupt += 1;

        results.issues.push({
          status: r.status,
          file: rel(f),
          error: r.error || ""
        });
      }
    }

    if (!verbose) {
      // En mode non-verbose, on ne garde pas le compteur "ok" si ça t'intéresse pas.
      // (mais on le laisse - c'est utile, et pas lourd)
    }

    const httpStatus = results.ok ? 200 : 503;
    return res.status(httpStatus).json(results);
  } catch (e) {
    return res.status(500).json({
      ok: false,
      error: "health_data_failed",
      details: e?.message || String(e)
    });
  }
});

export default router;
