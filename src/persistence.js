// Snapshot persistence — data/snapshot.json (latest) plus a compact history
// (data/snapshot-history.json) of counts and follower changes per snapshot,
// which powers the dashboard's trend and "who unfollowed you" views.

const fs = require("fs");
const path = require("path");

const DATA_DIR = path.join(__dirname, "..", "data");
const SNAPSHOT_PATH = path.join(DATA_DIR, "snapshot.json");
const SNAPSHOT_HISTORY_PATH = path.join(DATA_DIR, "snapshot-history.json");
const MAX_HISTORY_ENTRIES = 365;
const MAX_CHANGE_LIST = 500;   // usernames kept per gained/lost list
// A followers list this much smaller than the previous one is almost certainly
// a partial scan; diffing it would report thousands of fake "lost" followers.
const PARTIAL_RATIO = 0.75;

function writeAtomic(file, data) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
}

function loadSnapshot() {
  try {
    return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, "utf8"));
  } catch {
    return null;
  }
}

function loadSnapshotHistory() {
  try {
    const h = JSON.parse(fs.readFileSync(SNAPSHOT_HISTORY_PATH, "utf8"));
    return Array.isArray(h) ? h : [];
  } catch {
    return [];
  }
}

function countsEntry(snap) {
  return {
    at: snap.scannedAt || new Date().toISOString(),
    owner: snap.owner,
    source: snap.source || "scan",
    followers: (snap.followers || []).length,
    following: (snap.following || []).length,
  };
}

function appendSnapshotHistory(prev, next) {
  const history = loadSnapshotHistory();
  // First save since history existed: seed with the snapshot being replaced so
  // the trend starts from it and the first diff has a baseline.
  if (history.length === 0 && prev && prev.owner === next.owner) {
    history.push(countsEntry(prev));
  }

  const entry = countsEntry(next);
  const prevFollowers = prev && prev.owner === next.owner ? prev.followers || [] : null;
  const nextFollowers = next.followers || [];
  if (prevFollowers && prevFollowers.length) {
    if (nextFollowers.length < prevFollowers.length * PARTIAL_RATIO) {
      entry.diffSkipped = "followers list looks partial";
    } else {
      const before = new Set(prevFollowers);
      const after = new Set(nextFollowers);
      const gained = nextFollowers.filter((u) => !before.has(u));
      const lost = prevFollowers.filter((u) => !after.has(u));
      entry.gained = gained.length;
      entry.lost = lost.length;
      entry.gainedList = gained.slice(0, MAX_CHANGE_LIST);
      entry.lostList = lost.slice(0, MAX_CHANGE_LIST);
    }
  }

  history.push(entry);
  writeAtomic(SNAPSHOT_HISTORY_PATH, history.slice(-MAX_HISTORY_ENTRIES));
}

function saveSnapshot(snapshot) {
  const prev = loadSnapshot();
  writeAtomic(SNAPSHOT_PATH, snapshot);
  // History is a nice-to-have; never let it break saving the snapshot itself.
  try { appendSnapshotHistory(prev, snapshot); } catch {}
}

// Trend points + latest follower changes for the current owner. Falls back to a
// single point from the current snapshot when no history exists yet.
function snapshotTrend(owner, limit = 30) {
  let entries = loadSnapshotHistory().filter((e) => !owner || e.owner === owner);
  if (entries.length === 0) {
    const snap = loadSnapshot();
    if (snap && (!owner || snap.owner === owner)) entries = [countsEntry(snap)];
  }
  const points = entries.slice(-limit).map(({ at, source, followers, following, gained, lost }) =>
    ({ at, source, followers, following, gained, lost }));
  const latestDiff = [...entries].reverse().find((e) => typeof e.gained === "number") || null;
  const changes = latestDiff
    ? {
        at: latestDiff.at,
        since: (entries[entries.indexOf(latestDiff) - 1] || {}).at || null,
        gained: latestDiff.gained,
        lost: latestDiff.lost,
        gainedList: latestDiff.gainedList || [],
        lostList: latestDiff.lostList || [],
      }
    : null;
  return { points, changes };
}

module.exports = { saveSnapshot, loadSnapshot, snapshotTrend, DATA_DIR };
