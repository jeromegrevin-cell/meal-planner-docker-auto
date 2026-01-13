// backend/scripts/check-json.js
import { promises as fs } from "fs";
import path from "path";

const TARGET_DIRS = ["data/weeks", "data/recipes"];
const QUARANTINE_DIR = "data/_quarantine";

function isFixMode() {
  return process.argv.includes("--fix");
}

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
      if (e?.code === "ENOENT") return; // directory missing -> not an error
      throw e;
    }

    for (const ent of entries) {
      const full = path.join(current, ent.name);
      if (ent.isDirectory()) {
        await walk(full);
      } else if (ent.isFile() && ent.name.toLowerCase().endsWith(".json")) {
        files.push(full);
      }
    }
  }

  await walk(dirPath);
  return files;
}

async function checkOne(filePath) {
  // returns: { status: "OK"|"EMPTY"|"CORRUPT", error?: string }
  let buf;
  try {
    buf = await fs.readFile(filePath, "utf8");
  } catch (e) {
    return { status: "CORRUPT", error: `read_failed: ${e?.message || String(e)}` };
  }

  const trimmed = String(buf ?? "").trim();
  if (!trimmed) return { status: "EMPTY" };

  try {
    JSON.parse(trimmed);
    return { status: "OK" };
  } catch (e) {
    return { status: "CORRUPT", error: e?.message || String(e) };
  }
}

function relFromCwd(p) {
  return path.relative(process.cwd(), p) || p;
}

async function quarantineFile(filePath, reason) {
  const qRoot = path.join(process.cwd(), QUARANTINE_DIR);
  await fs.mkdir(qRoot, { recursive: true });

  // Preserve relative path structure under quarantine
  const rel = path.relative(process.cwd(), filePath);
  const destDir = path.join(qRoot, path.dirname(rel));
  await fs.mkdir(destDir, { recursive: true });

  const base = path.basename(filePath);
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dest = path.join(destDir, `${base}.${reason}.${stamp}`);

  await fs.rename(filePath, dest);
  return dest;
}

async function main() {
  const fix = isFixMode();

  const problems = [];
  let total = 0;

  for (const d of TARGET_DIRS) {
    const absDir = path.join(process.cwd(), d);
    const dirExists = await exists(absDir);

    console.log(`== ${d} ==`);
    if (!dirExists) {
      console.log("(missing directory)");
      continue;
    }

    const jsonFiles = await listJsonFiles(absDir);
    if (jsonFiles.length === 0) {
      console.log("(no json files)");
      continue;
    }

    for (const f of jsonFiles) {
      total += 1;
      const r = await checkOne(f);

      if (r.status === "OK") continue;

      const item = {
        dir: d,
        file: relFromCwd(f),
        status: r.status,
        error: r.error || ""
      };
      problems.push(item);

      if (!fix) {
        if (r.status === "EMPTY") console.log(`EMPTY   ${item.file}`);
        else console.log(`CORRUPT ${item.file} - ${item.error}`);
      } else {
        const reason = r.status === "EMPTY" ? "EMPTY" : "CORRUPT";
        const dest = await quarantineFile(f, reason);
        if (r.status === "EMPTY") {
          console.log(`MOVED(EMPTY)   ${item.file} -> ${relFromCwd(dest)}`);
        } else {
          console.log(`MOVED(CORRUPT) ${item.file} -> ${relFromCwd(dest)} (${item.error})`);
        }
      }
    }
  }

  console.log("");
  console.log(`Scanned: ${total} JSON file(s)`);
  console.log(`Issues : ${problems.length}`);

  if (problems.length > 0) {
    if (!fix) {
      console.log("");
      console.log("Tip: re-run with --fix to move bad files into data/_quarantine/");
      console.log("Example: node scripts/check-json.js --fix");
    }
    process.exit(1);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("check-json failed:", e?.stack || e?.message || String(e));
  process.exit(2);
});
