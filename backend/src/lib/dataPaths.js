import fs from "fs";
import path from "path";

const START_ROOT = process.cwd();

function resolveDataDir() {
  const envDir = (process.env.MEAL_PLANNER_DATA_DIR || "").trim();
  if (envDir) return envDir;

  const candidates = [
    path.join(START_ROOT, "backend", "data"),
    path.join(START_ROOT, "data"),
    path.join(path.resolve(START_ROOT, ".."), "backend", "data"),
    path.join(path.resolve(START_ROOT, ".."), "data")
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }

  return path.join(START_ROOT, "backend", "data");
}

const DATA_DIR = resolveDataDir();

function resolveProjectRoot(dataDir) {
  const norm = path.normalize(dataDir);
  if (norm.endsWith(path.join("backend", "data"))) {
    return path.resolve(dataDir, "..", "..");
  }
  if (norm.endsWith(path.sep + "data") || norm.endsWith("data")) {
    return path.resolve(dataDir, "..");
  }
  return START_ROOT;
}

const PROJECT_ROOT = resolveProjectRoot(DATA_DIR);

export { DATA_DIR, PROJECT_ROOT };
