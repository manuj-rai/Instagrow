// Persistent record of follow/unfollow actions so we never re-act on the same
// account across runs. Stored at data/history.json as username -> ISO-timestamp
// maps (object keys give O(1) lookups and natural de-duplication):
//
//   { "followed":   { "alice": "2026-06-19T10:00:00.000Z", ... },
//     "unfollowed": { "bob":   "2026-06-19T11:00:00.000Z", ... } }
//
// Functions are stateless over the file (load -> modify -> save). Only one job
// runs at a time (guarded by state.running), and actions are seconds apart, so
// rewriting the whole file per action is cheap and always crash-consistent.

const fs = require("fs");
const path = require("path");
const { normalizeUsername } = require("./utils");

const DATA_DIR = path.join(__dirname, "..", "data");
const HISTORY_PATH = path.join(DATA_DIR, "history.json");

function emptyHistory() {
  return { followed: {}, unfollowed: {} };
}

function loadHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, "utf8"));
    return {
      followed: raw && typeof raw.followed === "object" && raw.followed ? raw.followed : {},
      unfollowed: raw && typeof raw.unfollowed === "object" && raw.unfollowed ? raw.unfollowed : {},
    };
  } catch {
    return emptyHistory();
  }
}

function saveHistory(history) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  // Atomic write: tmp file + rename, so a crash mid-write can't corrupt history.
  const tmp = HISTORY_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(history, null, 2));
  fs.renameSync(tmp, HISTORY_PATH);
}

// Records an action. Idempotent — re-recording an existing username is a no-op
// (keeps the original timestamp and skips the disk write).
function record(kind, username) {
  const u = normalizeUsername(username);
  if (!u) return;
  const history = loadHistory();
  if (!history[kind][u]) {
    history[kind][u] = new Date().toISOString();
    saveHistory(history);
  }
}

function recordFollow(username) { record("followed", username); }
function recordUnfollow(username) { record("unfollowed", username); }

function followedSet() { return new Set(Object.keys(loadHistory().followed)); }
function unfollowedSet() { return new Set(Object.keys(loadHistory().unfollowed)); }

function historyCounts() {
  const h = loadHistory();
  return {
    followed: Object.keys(h.followed).length,
    unfollowed: Object.keys(h.unfollowed).length,
  };
}

// which: "all" | "followed" | "unfollowed"
function clearHistory(which = "all") {
  if (which === "all") return saveHistory(emptyHistory());
  const h = loadHistory();
  if (which === "followed") h.followed = {};
  else if (which === "unfollowed") h.unfollowed = {};
  else return;
  saveHistory(h);
}

module.exports = {
  HISTORY_PATH,
  loadHistory,
  recordFollow,
  recordUnfollow,
  followedSet,
  unfollowedSet,
  historyCounts,
  clearHistory,
};
