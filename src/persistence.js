// Snapshot persistence — read/write Backend/data/snapshot.json.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SNAPSHOT_PATH = path.join(DATA_DIR, "snapshot.json");

function saveSnapshot(snapshot) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
}

function loadSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
  } catch {
    return null;
  }
}

module.exports = { saveSnapshot, loadSnapshot, SNAPSHOT_PATH, DATA_DIR };
