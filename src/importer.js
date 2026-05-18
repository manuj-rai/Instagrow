// Watches a local folder (typically a Google Drive desktop-sync target) for
// new Instagram "Download your information" exports. Handles two delivery
// formats:
//   1. A .zip file (manual download → drop into folder)
//   2. An extracted folder tree like:
//        <watch>/[meta-<date>/]instagram-<username>-<date>-<rand>/
//          connections/followers_and_following/followers_*.json
//          connections/followers_and_following/following.json
//      (this is what Meta's "Schedule transfer to Google Drive" delivers)
//
// On each new export, extracts followers + following usernames and writes them
// to data/snapshot.json — the same format the rest of the app already reads.

const fs = require("fs");
const path = require("path");
const StreamZip = require("node-stream-zip");

const { log, state } = require("./state");
const { saveSnapshot } = require("./persistence");
const { normalizeUsername } = require("./utils");
const { DATA_DIR } = require("./persistence");

const IMPORT_STATE_PATH = path.join(DATA_DIR, "import-state.json");

function loadImportState() {
  try {
    return JSON.parse(fs.readFileSync(IMPORT_STATE_PATH, "utf8"));
  } catch {
    return { processedKeys: {}, lastImportedAt: null, lastError: null };
  }
}

function saveImportState(s) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(IMPORT_STATE_PATH, JSON.stringify(s, null, 2));
}

/* ---------------- JSON parsing ---------------- */

function extractEntries(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === "object") {
    for (const k of Object.keys(parsed)) {
      if (/^relationships_/.test(k) && Array.isArray(parsed[k])) return parsed[k];
    }
  }
  return [];
}

function entryToUsername(entry) {
  if (!entry || typeof entry !== "object") return null;
  const sld = entry.string_list_data;
  if (Array.isArray(sld) && sld.length > 0) {
    const first = sld[0];
    if (first && first.value) return String(first.value);
    if (first && first.href) {
      const m = String(first.href).match(/instagram\.com\/(?:_u\/)?([^/?#]+)/);
      if (m) return m[1];
    }
  }
  if (entry.title && typeof entry.title === "string") return entry.title;
  return null;
}

function usernamesFromBuffer(buf) {
  const parsed = JSON.parse(buf.toString("utf8"));
  return extractEntries(parsed)
    .map(entryToUsername)
    .filter(Boolean)
    .map(normalizeUsername)
    .filter(Boolean);
}

/* ---------------- Folder discovery ---------------- */

// A folder is an "IG export root" if it has connections/followers_and_following/following.json
// (or at least one followers_*.json) inside it.
function isExportRoot(dir) {
  const ff = path.join(dir, "connections", "followers_and_following");
  if (!fs.existsSync(ff)) return false;
  try {
    const files = fs.readdirSync(ff);
    return files.some((f) => /^followers?_?\d*\.json$/i.test(f)) ||
           files.some((f) => /^following\.json$/i.test(f));
  } catch {
    return false;
  }
}

// Walk up to MAX_DEPTH levels finding export roots. Returns absolute paths.
function findExportRoots(rootDir, maxDepth = 4) {
  const roots = [];
  if (!fs.existsSync(rootDir)) return roots;

  const queue = [{ dir: rootDir, depth: 0 }];
  const seen = new Set();
  while (queue.length) {
    const { dir, depth } = queue.shift();
    if (seen.has(dir)) continue;
    seen.add(dir);

    if (isExportRoot(dir)) {
      roots.push(dir);
      continue; // don't recurse into an export root
    }
    if (depth >= maxDepth) continue;

    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (ent.isDirectory() && !ent.name.startsWith(".")) {
        queue.push({ dir: path.join(dir, ent.name), depth: depth + 1 });
      }
    }
  }
  return roots;
}

function ownerFromFolderName(dir, fallback) {
  const base = path.basename(dir);
  // Pattern: instagram-<username>-<YYYY-MM-DD>-<rand>
  const m = base.match(/^instagram-([a-z0-9._]+)-\d{4}-\d{2}-\d{2}/i);
  if (m) return normalizeUsername(m[1]);
  return fallback ? normalizeUsername(fallback) : "";
}

// Stable fingerprint for a folder so we don't reprocess unchanged data.
// Uses: path + sorted (name:size:mtime) of every followers/following JSON.
function folderKey(rootDir) {
  const ff = path.join(rootDir, "connections", "followers_and_following");
  const parts = [];
  try {
    const files = fs.readdirSync(ff)
      .filter((f) => /^(followers?_?\d*|following)\.json$/i.test(f))
      .sort();
    for (const f of files) {
      const st = fs.statSync(path.join(ff, f));
      parts.push(`${f}:${st.size}:${st.mtimeMs}`);
    }
  } catch {}
  return `dir:${rootDir}|${parts.join(",")}`;
}

/* ---------------- Single-export processing ---------------- */

async function importFromFolder(rootDir, fallbackOwner) {
  const ff = path.join(rootDir, "connections", "followers_and_following");
  const files = fs.readdirSync(ff);
  const followers = new Set();
  const following = new Set();

  for (const f of files) {
    const full = path.join(ff, f);
    const lower = f.toLowerCase();
    if (/^followers?_?\d*\.json$/.test(lower)) {
      for (const u of usernamesFromBuffer(fs.readFileSync(full))) followers.add(u);
    } else if (/^following\.json$/.test(lower)) {
      for (const u of usernamesFromBuffer(fs.readFileSync(full))) following.add(u);
    }
  }

  const owner = ownerFromFolderName(rootDir, fallbackOwner);
  if (!owner) {
    throw new Error(
      `owner unknown — couldn't parse username from folder name '${path.basename(rootDir)}'. ` +
      "Set IG_IMPORT_OWNER env var to your IG username."
    );
  }
  if (followers.size === 0 && following.size === 0) {
    throw new Error("no followers or following found inside connections/followers_and_following/");
  }

  saveSnapshot({
    owner,
    scannedAt: new Date().toISOString(),
    source: "data_download_auto",
    sourceFolder: path.basename(rootDir),
    followers: Array.from(followers),
    following: Array.from(following),
  });
  state.lastUsername = owner;

  return { owner, followers: followers.size, following: following.size };
}

async function importFromZip(zipPath, fallbackOwner) {
  const zip = new StreamZip.async({ file: zipPath });
  try {
    const entries = await zip.entries();
    const followers = new Set();
    const following = new Set();
    let owner = fallbackOwner ? normalizeUsername(fallbackOwner) : "";

    for (const entry of Object.values(entries)) {
      if (entry.isDirectory) continue;
      const name = entry.name.toLowerCase();
      if (/connections\/followers_and_following\/followers?_?\d*\.json$/.test(name)) {
        const buf = await zip.entryData(entry.name);
        for (const u of usernamesFromBuffer(buf)) followers.add(u);
      } else if (/connections\/followers_and_following\/following\.json$/.test(name)) {
        const buf = await zip.entryData(entry.name);
        for (const u of usernamesFromBuffer(buf)) following.add(u);
      } else if (!owner && /personal_information\/personal_information\.json$/.test(name)) {
        try {
          const buf = await zip.entryData(entry.name);
          const parsed = JSON.parse(buf.toString("utf8"));
          const profile = parsed.profile_user || parsed;
          const sm = profile && profile[0] && profile[0].string_map_data;
          const u = sm && (sm.Username || sm.username);
          if (u && u.value) owner = normalizeUsername(u.value);
        } catch {}
      }
    }

    // Best-effort owner recovery from zip filename too (e.g. instagram-<user>-<date>.zip)
    if (!owner) {
      const m = path.basename(zipPath).match(/^instagram-([a-z0-9._]+)-\d{4}-\d{2}-\d{2}/i);
      if (m) owner = normalizeUsername(m[1]);
    }
    if (!owner) {
      throw new Error(
        "owner unknown — set IG_IMPORT_OWNER env var, or ensure the zip contains personal_information.json"
      );
    }
    if (followers.size === 0 && following.size === 0) {
      throw new Error("no followers or following found in ZIP");
    }

    saveSnapshot({
      owner,
      scannedAt: new Date().toISOString(),
      source: "data_download_auto",
      sourceFile: path.basename(zipPath),
      followers: Array.from(followers),
      following: Array.from(following),
    });
    state.lastUsername = owner;

    return { owner, followers: followers.size, following: following.size };
  } finally {
    await zip.close();
  }
}

/* ---------------- Polling ---------------- */

async function pollOnce(config) {
  if (!config.importDir) return;
  if (!fs.existsSync(config.importDir)) return;

  const importState = loadImportState();

  // Collect candidate work items: folders AND zips.
  const items = [];

  // Folders (anywhere up to maxDepth inside the watched dir)
  for (const dir of findExportRoots(config.importDir, 5)) {
    const key = folderKey(dir);
    let mtime = 0;
    try {
      const st = fs.statSync(dir);
      mtime = st.mtimeMs;
    } catch {}
    items.push({ kind: "folder", path: dir, key, mtime });
  }

  // Zips at top level only
  try {
    for (const ent of fs.readdirSync(config.importDir, { withFileTypes: true })) {
      if (!ent.isFile() || !/\.zip$/i.test(ent.name)) continue;
      const full = path.join(config.importDir, ent.name);
      const st = fs.statSync(full);
      items.push({
        kind: "zip",
        path: full,
        key: `zip:${ent.name}:${st.size}:${st.mtimeMs}`,
        mtime: st.mtimeMs,
      });
    }
  } catch (err) {
    log(`⚠️  Could not read import dir ${config.importDir}: ${err.message}`);
  }

  // Process oldest-first so the newest export's snapshot wins.
  items.sort((a, b) => a.mtime - b.mtime);

  for (const item of items) {
    if (importState.processedKeys[item.key]) continue;
    if (state.running) return; // don't clobber a live job; retry next tick

    log(`📥 Auto-import: processing ${item.kind} ${path.basename(item.path)}...`);
    try {
      const res = item.kind === "zip"
        ? await importFromZip(item.path, config.importOwner)
        : await importFromFolder(item.path, config.importOwner);
      log(`✓ Auto-import done for @${res.owner}: ${res.followers} followers, ${res.following} following`);
      importState.processedKeys[item.key] = new Date().toISOString();
      importState.lastImportedAt = new Date().toISOString();
      importState.lastImportedFile = path.basename(item.path);
      importState.lastImportedCounts = { followers: res.followers, following: res.following };
      importState.lastImportedOwner = res.owner;
      importState.lastError = null;
    } catch (err) {
      log(`✗ Auto-import failed for ${path.basename(item.path)}: ${err.message}`);
      importState.lastError = {
        file: path.basename(item.path),
        message: err.message,
        at: new Date().toISOString(),
      };
      // Mark as processed so we don't loop forever on a broken export.
      importState.processedKeys[item.key] = new Date().toISOString();
    }
    saveImportState(importState);
  }
}

/* ---------------- Lifecycle ---------------- */

let pollTimer = null;

function startImporter(config) {
  if (pollTimer) clearInterval(pollTimer);
  if (!config.importDir) {
    log("🗂️  Auto-import disabled (IG_IMPORT_DIR not set).");
    return;
  }
  log(`🗂️  Auto-import watching ${config.importDir} (poll every ${Math.round(config.importPollMs / 1000)}s)`);
  pollOnce(config).catch((err) => log(`Auto-import error: ${err.message}`));
  pollTimer = setInterval(() => {
    pollOnce(config).catch((err) => log(`Auto-import error: ${err.message}`));
  }, config.importPollMs);
}

function getImporterStatus(config) {
  const s = loadImportState();
  return {
    enabled: !!config.importDir,
    dir: config.importDir || null,
    pollMs: config.importPollMs,
    lastImportedAt: s.lastImportedAt || null,
    lastImportedFile: s.lastImportedFile || null,
    lastImportedOwner: s.lastImportedOwner || null,
    lastImportedCounts: s.lastImportedCounts || null,
    lastError: s.lastError || null,
  };
}

module.exports = { startImporter, getImporterStatus };
