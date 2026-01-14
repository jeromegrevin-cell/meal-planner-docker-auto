import express from "express";
import path from "path";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import { spawn } from "child_process";
import { readJson, writeJson } from "../lib/jsonStore.js";

const router = express.Router();

const JOBS_DIR = path.join(process.cwd(), "data", "drive_jobs");
const LOGS_DIR = path.join(JOBS_DIR, "logs");

// On evite les rescans concurrents en memoire (suffisant en dev host)
let runningJobId = null;

function nowIso() {
  return new Date().toISOString();
}

function jobPath(jobId) {
  return path.join(JOBS_DIR, `${jobId}.json`);
}

async function ensureDirs() {
  await fs.mkdir(LOGS_DIR, { recursive: true });
}

async function listJobFiles() {
  try {
    const files = await fs.readdir(JOBS_DIR);
    return files.filter((f) => f.endsWith(".json"));
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
}

async function safeReadJson(p) {
  try {
    return await readJson(p);
  } catch (_e) {
    return null;
  }
}

async function getLatestJob() {
  const files = await listJobFiles();
  if (files.length === 0) return null;

  // Trier par mtime desc
  const stats = await Promise.all(
    files.map(async (f) => {
      const p = path.join(JOBS_DIR, f);
      const st = await fs.stat(p);
      return { file: f, mtimeMs: st.mtimeMs };
    })
  );

  stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const latestFile = stats[0].file;

  const latestPath = path.join(JOBS_DIR, latestFile);
  const latest = await safeReadJson(latestPath);
  return latest || null;
}

async function fileExists(p) {
  try {
    await fs.access(p);
    return true;
  } catch (_e) {
    return false;
  }
}

async function resolveRescanScriptPath() {
  const candidates = [
    // Contexte normal: backend/ -> script a la racine
    path.join(process.cwd(), "..", "recettes_rescan.py"),
    // Si lance depuis la racine
    path.join(process.cwd(), "recettes_rescan.py"),
    // Legacy path si jamais le script est sous scripts/
    path.join(process.cwd(), "..", "scripts", "recettes_rescan.py"),
    path.join(process.cwd(), "scripts", "recettes_rescan.py")
  ];

  for (const p of candidates) {
    if (await fileExists(p)) return p;
  }

  // Dernier recours: on renvoie le chemin attendu (message d'erreur clair au runtime)
  return candidates[0];
}

/**
 * GET /api/drive/rescan/status
 * Retourne le dernier job (ou null)
 */
router.get("/rescan/status", async (_req, res) => {
  try {
    const latest = await getLatestJob();
    res.json({
      ok: true,
      latest: latest || null,
      running_job_id: runningJobId
    });
  } catch (e) {
    res.status(500).json({
      ok: false,
      error: "drive_status_failed",
      details: e.message
    });
  }
});

/**
 * POST /api/drive/rescan
 * Lance scripts/recettes_rescan.py (racine projet)
 */
router.post("/rescan", async (_req, res) => {
  try {
    await ensureDirs();

    // Interdire rescan concurrent
    if (runningJobId) {
      const current = await safeReadJson(jobPath(runningJobId));
      return res.status(409).json({
        ok: false,
        error: "rescan_already_running",
        running_job_id: runningJobId,
        running_job: current
      });
    }

    const jobId = `rescan_${Date.now()}`;
    const logFile = path.join(LOGS_DIR, `${jobId}.log`);

    const scriptPath = await resolveRescanScriptPath();

    const job = {
      job_id: jobId,
      type: "drive_recettes_rescan",
      status: "queued", // queued | running | done | failed
      created_at: nowIso(),
      started_at: null,
      finished_at: null,
      exit_code: null,
      script_path: scriptPath,
      log_path: logFile,
      error: null
    };

    await writeJson(jobPath(jobId), job);

    // Reponse immediate
    res.status(202).json({ ok: true, job });

    // Lancement async
    runningJobId = jobId;

    job.status = "running";
    job.started_at = nowIso();
    await writeJson(jobPath(jobId), job);

    const out = createWriteStream(logFile, { flags: "a" });

    const projectRoot = path.join(process.cwd(), ".."); // backend/ -> racine
    const child = spawn("python3", [scriptPath], {
      cwd: projectRoot,
      env: process.env
    });

    child.stdout.pipe(out);
    child.stderr.pipe(out);

    child.on("error", async (err) => {
      const j = (await safeReadJson(jobPath(jobId))) || job;
      j.status = "failed";
      j.finished_at = nowIso();
      j.exit_code = null;
      j.error = `spawn_error:${err.message}`;
      await writeJson(jobPath(jobId), j);

      out.end();
      runningJobId = null;
    });

    child.on("close", async (code) => {
      const j = (await safeReadJson(jobPath(jobId))) || job;
      j.finished_at = nowIso();
      j.exit_code = Number(code);

      if (code === 0) {
        j.status = "done";
        j.error = null;
      } else {
        j.status = "failed";
        j.error = `exit_code:${code}`;
      }

      await writeJson(jobPath(jobId), j);

      runningJobId = null;
      out.end();
    });
  } catch (e) {
    runningJobId = null;
    res.status(500).json({
      ok: false,
      error: "drive_rescan_failed",
      details: e.message
    });
  }
});

export default router;
