// lib/jsonStore.js
import { promises as fs } from "fs";
import path from "path";

export async function readJson(filePath) {
  const raw = await fs.readFile(filePath, "utf-8");
  const trimmed = String(raw ?? "").trim();

  // Evite JSON.parse("") -> "Unexpected end of JSON input"
  // On renvoie une erreur explicite (reste catchable comme avant).
  if (!trimmed) {
    const err = new Error(`Empty JSON file: ${filePath}`);
    err.code = "EMPTY_JSON";
    throw err;
  }

  return JSON.parse(trimmed);
}

/**
 * Ecriture atomique:
 * - écrit dans un fichier temporaire dans le même dossier
 * - fsync (best effort)
 * - rename -> remplacement atomique sur la plupart des FS
 */
export async function writeJson(filePath, data) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });

  const raw = JSON.stringify(data, null, 2) + "\n";

  // Temp file in same directory => rename atomique
  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;

  // 1) write temp
  const fh = await fs.open(tmpPath, "w");
  try {
    await fh.writeFile(raw, "utf-8");
    // 2) flush best-effort
    try {
      await fh.sync();
    } catch {
      // certains FS / environnements peuvent refuser sync -> ok
    }
  } finally {
    await fh.close();
  }

  // 3) atomic replace
  await fs.rename(tmpPath, filePath);
}
