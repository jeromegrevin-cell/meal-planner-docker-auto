import fs from "fs";
import path from "path";

const PROJECT_ROOT = process.cwd();

function resolveDataDir() {
  const envDir = (process.env.MEAL_PLANNER_DATA_DIR || "").trim();
  if (envDir) return envDir;

  const candidates = [
    path.join(PROJECT_ROOT, "backend", "data"),
    path.join(PROJECT_ROOT, "data"),
    path.join(path.resolve(PROJECT_ROOT, ".."), "backend", "data"),
    path.join(path.resolve(PROJECT_ROOT, ".."), "data")
  ];

  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      // ignore
    }
  }

  return path.join(PROJECT_ROOT, "backend", "data");
}

const DATA_DIR = resolveDataDir();

export { DATA_DIR };
