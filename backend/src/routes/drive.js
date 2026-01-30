import express from "express";
import path from "path";
import fs from "fs/promises";
import { createWriteStream } from "fs";
import { spawn } from "child_process";
import os from "os";
import { readJson, writeJson } from "../lib/jsonStore.js";
import { DATA_DIR } from "../lib/dataPaths.js";
import { readDriveState, updateLastRescan } from "../lib/driveState.js";
import { PROJECT_ROOT } from "../lib/dataPaths.js";

const router = express.Router();

const JOBS_DIR = path.join(DATA_DIR, "drive_jobs");
const LOGS_DIR = path.join(JOBS_DIR, "logs");

// On evite les rescans concurrents en memoire (suffisant en dev host)
let runningJobId = null;
let lastRescanAtMs = 0;

const MIN_RESCAN_INTERVAL_MS = Number(
  process.env.DRIVE_RESCAN_MIN_INTERVAL_MS || 60_000
);
const MAX_RESCAN_RUNTIME_MS = Number(
  process.env.DRIVE_RESCAN_MAX_RUNTIME_MS || 15 * 60_000
);

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

async function finalizeJob(jobId, updater, fallback) {
  const current = (await safeReadJson(jobPath(jobId))) || fallback || {};
  const next = typeof updater === "function" ? updater(current) : current;
  await writeJson(jobPath(jobId), next);
  return next;
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
    // Projet monté ailleurs (Docker)
    path.join(PROJECT_ROOT, "recettes_rescan.py"),
    // Legacy path si jamais le script est sous scripts/
    path.join(process.cwd(), "..", "scripts", "recettes_rescan.py"),
    path.join(process.cwd(), "scripts", "recettes_rescan.py"),
    path.join(PROJECT_ROOT, "scripts", "recettes_rescan.py")
  ];

  for (const p of candidates) {
    if (await fileExists(p)) return p;
  }

  // Dernier recours: on renvoie le chemin attendu (message d'erreur clair au runtime)
  return candidates[0];
}

async function resolvePythonBin() {
  const fromEnv = (process.env.PYTHON_BIN || "").trim();
  if (fromEnv) return fromEnv;

  const candidates = [
    // Prefer local venv if present
    path.join(process.cwd(), "..", ".venv", "bin", "python"),
    path.join(process.cwd(), ".venv", "bin", "python"),
    path.join(PROJECT_ROOT, ".venv", "bin", "python"),
    // Fallbacks
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

async function readRescanProgress(logPath) {
  if (!logPath) return null;
  try {
    const raw = await fs.readFile(logPath, "utf8");
    const tail = raw.slice(-20000);
    const re = /\[(\d+)\/(\d+)\]/g;
    let m;
    let last = null;
    while ((m = re.exec(tail))) {
      last = { scanned: Number(m[1]), total: Number(m[2]) };
    }
    return last;
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * GET /api/drive/rescan/status
 * Retourne le dernier job (ou null)
 */
router.get("/rescan/status", async (_req, res) => {
  try {
    const latest = await getLatestJob();
    if (latest?.status === "running" && latest?.pid && !isProcessAlive(latest.pid)) {
      const patched = await finalizeJob(
        latest.job_id,
        (j) => ({
          ...j,
          status: "failed",
          finished_at: nowIso(),
          exit_code: null,
          error: "process_not_running"
        }),
        latest
      );
      return res.json({
        ok: true,
        latest: patched,
        running_job_id: null,
        last_upload_at: (await readDriveState()).last_upload_at,
        last_rescan_at: (await readDriveState()).last_rescan_at,
        rescan_required: false,
        progress: null
      });
    }
    const progress = await readRescanProgress(latest?.log_path);
    const state = await readDriveState();
    const lastUploadAt = state.last_upload_at ? Date.parse(state.last_upload_at) : null;
    const lastRescanAt = state.last_rescan_at ? Date.parse(state.last_rescan_at) : null;
    const now = Date.now();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    const lastActionAt = Math.max(lastUploadAt || 0, lastRescanAt || 0);
    const rescanRequired =
      (lastUploadAt && (!lastRescanAt || lastUploadAt > lastRescanAt)) ||
      (lastActionAt > 0 && now - lastActionAt > sevenDaysMs);

    if (latest?.status === "running" && latest?.started_at) {
      const startedAt = Date.parse(latest.started_at);
      if (!Number.isNaN(startedAt)) {
        const ageMs = Date.now() - startedAt;
        if (ageMs > MAX_RESCAN_RUNTIME_MS) {
          const patched = await finalizeJob(
            latest.job_id,
            (j) => ({
              ...j,
              status: "failed",
              finished_at: nowIso(),
              exit_code: null,
              error: "stale_running_job_timeout"
            }),
            latest
          );
          return res.json({
            ok: true,
            latest: patched,
            running_job_id: runningJobId
          });
        }
      }
    }
    res.json({
      ok: true,
      latest: latest || null,
      running_job_id: runningJobId,
      last_upload_at: state.last_upload_at,
      last_rescan_at: state.last_rescan_at,
      rescan_required: rescanRequired,
      progress
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

    const now = Date.now();
    if (now - lastRescanAtMs < MIN_RESCAN_INTERVAL_MS) {
      return res.status(429).json({
        ok: false,
        error: "rescan_rate_limited",
        details: `Wait ${Math.ceil(
          (MIN_RESCAN_INTERVAL_MS - (now - lastRescanAtMs)) / 1000
        )}s before next rescan`
      });
    }

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
    const pythonBin = await resolvePythonBin();
    const credentialsPath = await resolveCredentialsPath();
    if (!credentialsPath) {
      return res.status(500).json({
        ok: false,
        error: "missing_service_account",
        details: "Set MEAL_PLANNER_SECRETS_DIR or GOOGLE_APPLICATION_CREDENTIALS"
      });
    }

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
    lastRescanAtMs = now;
    await updateLastRescan();

    job.status = "running";
    job.started_at = nowIso();
    await writeJson(jobPath(jobId), job);

    const out = createWriteStream(logFile, { flags: "a" });
    const logLine = (line) => {
      try {
        out.write(`${line}\n`);
      } catch (_e) {}
    };
    logLine(`[${nowIso()}] rescan_start`);

    const projectRoot = path.join(process.cwd(), ".."); // backend/ -> racine
    const env = { ...process.env };
    env.GOOGLE_APPLICATION_CREDENTIALS = credentialsPath;
    if (!env.MEAL_PLANNER_SECRETS_DIR && credentialsPath) {
      const secretsDir = path.dirname(path.dirname(credentialsPath));
      env.MEAL_PLANNER_SECRETS_DIR = secretsDir;
    }

    // Force unbuffered output so logs + progress are visible in real time.
    env.PYTHONUNBUFFERED = "1";
    const command = `${pythonBin} -u "${scriptPath}"`;
    logLine(`command=${command}`);
    logLine(`cwd=${projectRoot}`);
    logLine(`pythonBin=${pythonBin}`);
    logLine(`scriptPath=${scriptPath}`);
    logLine(
      `GOOGLE_APPLICATION_CREDENTIALS=${env.GOOGLE_APPLICATION_CREDENTIALS || "unset"}`
    );
    logLine(
      `MEAL_PLANNER_SECRETS_DIR=${env.MEAL_PLANNER_SECRETS_DIR || "unset"}`
    );
    const child = spawn(pythonBin, ["-u", scriptPath], {
      cwd: projectRoot,
      env
    });

    child.stdout.pipe(out);
    child.stderr.pipe(out);

    // Persist PID for traceability
    await finalizeJob(
      jobId,
      (j) => ({ ...j, pid: child.pid }),
      job
    );

    let finalized = false;
    const finalizeOnce = async (updater) => {
      if (finalized) return;
      finalized = true;
      await finalizeJob(jobId, updater, job);
      runningJobId = null;
      out.end();
    };

    const timeout = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch (_e) {}
    }, MAX_RESCAN_RUNTIME_MS);

    child.on("error", async (err) => {
      clearTimeout(timeout);
      try {
        out.write(`spawn_error:${err.message}\n`);
      } catch (_e) {}
      await finalizeOnce((j) => ({
        ...j,
        status: "failed",
        finished_at: nowIso(),
        exit_code: null,
        error: `spawn_error:${err.message}`
      }));
    });

    child.on("close", async (code) => {
      clearTimeout(timeout);
      try {
        out.write(`exit_code:${code}\n`);
      } catch (_e) {}
      await finalizeOnce((j) => ({
        ...j,
        finished_at: nowIso(),
        exit_code: Number(code),
        status: code === 0 ? "done" : "failed",
        error: code === 0 ? null : `exit_code:${code}`
      }));
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
