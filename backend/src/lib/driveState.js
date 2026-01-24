import fs from "fs/promises";
import path from "path";
import { DATA_DIR } from "./dataPaths.js";

const STATE_PATH = path.join(DATA_DIR, "drive_state.json");

async function readState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    return JSON.parse(raw);
  } catch {
    return {
      last_upload_at: null,
      last_rescan_at: null
    };
  }
}

async function writeState(state) {
  const next = {
    last_upload_at: state.last_upload_at || null,
    last_rescan_at: state.last_rescan_at || null
  };
  await fs.writeFile(STATE_PATH, JSON.stringify(next, null, 2));
  return next;
}

async function updateLastUpload() {
  const state = await readState();
  state.last_upload_at = new Date().toISOString();
  return writeState(state);
}

async function updateLastRescan() {
  const state = await readState();
  state.last_rescan_at = new Date().toISOString();
  return writeState(state);
}

export { readState as readDriveState, updateLastUpload, updateLastRescan };
